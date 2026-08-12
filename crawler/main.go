package main

import (
	"context"
	"fmt"
	"log"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/bson/primitive"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

// The Go crawler. It shares nothing with the Node platform except the Mongo collections — no RPC, no
// generated stubs, no shared build. Both sides lease from `jobs` the same way, so either can be
// restarted, scaled or rewritten without the other noticing.
//
// It owns only the fetch-heavy stages. Anything needing the platform's own logic (the seed funnel,
// Prospeo, rollups) is left to the Node worker, because reimplementing that here would mean two
// versions of rules that must agree.

type Job struct {
	ID      primitive.ObjectID `bson:"_id"`
	Type    string             `bson:"type"`
	Payload bson.M             `bson:"payload"`
	RunID   primitive.ObjectID `bson:"runId"`
	Attempts int               `bson:"attempts"`
	MaxAttempts int            `bson:"maxAttempts"`
}

type Crawler struct {
	db      *mongo.Database
	fetch   *Fetcher
	worker  string
	maxCase int
}

// Never log a Mongo URI with credentials in it.
func redact(uri string) string {
	if i := strings.Index(uri, "@"); i > 0 {
		if j := strings.Index(uri, "://"); j >= 0 && j+3 < i {
			return uri[:j+3] + "***@" + uri[i+1:]
		}
	}
	return uri
}

func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func main() {
	uri := os.Getenv("MONGO_URI")
	if uri == "" {
		uri = "mongodb://mongo:27017"
	}
	dbName := os.Getenv("MONGO_DB")
	if dbName == "" {
		dbName = "gtm"
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	client, err := mongo.Connect(ctx, options.Client().ApplyURI(uri).SetMaxPoolSize(200))
	if err != nil {
		log.Fatalf("mongo connect: %v", err)
	}
	if err := client.Ping(ctx, nil); err != nil {
		log.Fatalf("mongo ping: %v", err)
	}

	// Split on newlines AND commas, matching src/lib/proxies.js. A comma-separated single-line
	// PROXIES would otherwise parse as one malformed entry here, silently leaving the crawler with
	// no proxies at all — which is not a crash, just every request going out from the server's own
	// IP until it gets blocked.
	var proxies []string
	for _, p := range strings.FieldsFunc(os.Getenv("PROXIES"), func(r rune) bool { return r == '\n' || r == '\r' || r == ',' }) {
		if s := strings.TrimSpace(p); s != "" {
			proxies = append(proxies, s)
		}
	}

	c := &Crawler{
		db:      client.Database(dbName),
		fetch:   NewFetcher(proxies),
		worker:  fmt.Sprintf("go-%d", os.Getpid()),
		maxCase: envInt("CRAWL_MAX_CASE_STUDIES", 40),
	}

	lanes := envInt("CRAWL_CONCURRENCY", 64)
	log.Printf("crawler up: lanes=%d proxies=%d db=%s uri=%s", lanes, len(proxies), dbName, redact(uri))

	// Prove WHICH database this is, not just its name. Two Mongo servers can both be called "gtm";
	// only their contents tell them apart. `leads` holds tens of thousands of documents on the real
	// one, so a zero there means this process is talking to a different server entirely — which no
	// amount of checking the connection string would reveal.
	if names, err := c.db.ListCollectionNames(ctx, bson.M{}); err != nil {
		log.Printf("STARTUP: cannot list collections: %v", err)
	} else {
		leads, _ := c.db.Collection("leads").EstimatedDocumentCount(ctx)
		log.Printf("STARTUP: collections=%d leads=%d (leads=0 means this is NOT the platform's database)", len(names), leads)
		if len(names) < 25 {
			log.Printf("STARTUP: collection names: %v", names)
		}
	}

	// Say what this process can actually SEE at startup. "Container is up" and "container can read
	// the queue" are different claims, and only the second one matters.
	if n, err := c.db.Collection("jobs").CountDocuments(ctx, bson.M{}); err != nil {
		log.Printf("STARTUP: cannot read jobs collection: %v", err)
	} else {
		claimable, _ := c.db.Collection("jobs").CountDocuments(ctx, bson.M{
			"type":  bson.M{"$in": []string{"agency:discover", "case:extract"}},
			"state": "queued",
		})
		log.Printf("STARTUP: jobs total=%d claimable-for-me=%d", n, claimable)
		if n > 0 && claimable == 0 {
			var sample bson.M
			if err := c.db.Collection("jobs").FindOne(ctx, bson.M{}).Decode(&sample); err == nil {
				log.Printf("STARTUP: sample job type=%v state=%v nextRunAt=%v", sample["type"], sample["state"], sample["nextRunAt"])
			}
		}
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-stop
		log.Println("draining…")
		cancel()
	}()

	var wg sync.WaitGroup
	for i := 0; i < lanes; i++ {
		wg.Add(1)
		go func(n int) { defer wg.Done(); c.lane(ctx, n) }(i)
	}
	wg.Wait()
	log.Println("stopped")
}

func (c *Crawler) lane(ctx context.Context, n int) {
	types := []string{"agency:discover", "case:extract"}
	for ctx.Err() == nil {
		job, err := c.lease(ctx, types, n)
		if err != nil {
			// NEVER swallow this. A connection or decode error looks exactly like "no work to do",
			// and a queue that is full while every lane reports idle is unreadable from outside.
			log.Printf("lane %d: lease error: %v", n, err)
		}
		if err != nil || job == nil {
			select {
			case <-time.After(2 * time.Second):
			case <-ctx.Done():
			}
			continue
		}

		// Renew the lease while the job runs, so a slow site never lets a second worker take it.
		beat, stopBeat := context.WithCancel(ctx)
		go func() {
			t := time.NewTicker(60 * time.Second)
			defer t.Stop()
			for {
				select {
				case <-t.C:
					c.db.Collection("jobs").UpdateByID(ctx, job.ID, bson.M{"$set": bson.M{"leaseUntil": time.Now().Add(5 * time.Minute)}})
				case <-beat.Done():
					return
				}
			}
		}()

		err = c.handle(ctx, job)
		stopBeat()

		if err != nil {
			c.fail(ctx, job, err)
		} else {
			c.complete(ctx, job)
		}
	}
}

// Claim one job. Identical semantics to the Node side's lease(): the same findOneAndUpdate, the same
// reclaim-on-expiry rule. Two implementations of one contract, which is the price of not running an
// RPC layer — and a much smaller price.
func (c *Crawler) lease(ctx context.Context, types []string, n int) (*Job, error) {
	now := time.Now()
	filter := bson.M{
		"type": bson.M{"$in": types},
		"$or": []bson.M{
			{"state": "queued", "nextRunAt": bson.M{"$lte": now}},
			{"state": "leased", "leaseUntil": bson.M{"$lt": now}},
		},
	}
	update := bson.M{
		"$set": bson.M{"state": "leased", "leaseUntil": now.Add(5 * time.Minute),
			"workerId": fmt.Sprintf("%s#%d", c.worker, n), "updatedAt": now},
		"$inc": bson.M{"attempts": 1},
	}
	opts := options.FindOneAndUpdate().
		SetSort(bson.D{{Key: "priority", Value: -1}, {Key: "nextRunAt", Value: 1}}).
		SetReturnDocument(options.After)

	var job Job
	err := c.db.Collection("jobs").FindOneAndUpdate(ctx, filter, update, opts).Decode(&job)
	if err == mongo.ErrNoDocuments {
		return nil, nil
	}
	return &job, err
}

func (c *Crawler) complete(ctx context.Context, job *Job) {
	c.db.Collection("jobs").UpdateByID(ctx, job.ID, bson.M{
		"$set": bson.M{"state": "done", "leaseUntil": nil, "finishedAt": time.Now(), "updatedAt": time.Now()},
	})
}

func (c *Crawler) fail(ctx context.Context, job *Job, err error) {
	max := job.MaxAttempts
	if max == 0 {
		max = 4
	}
	msg := err.Error()
	if len(msg) > 500 {
		msg = msg[:500]
	}
	if job.Attempts >= max {
		c.db.Collection("jobs").UpdateByID(ctx, job.ID, bson.M{
			"$set": bson.M{"state": "failed", "lastError": msg, "leaseUntil": nil, "finishedAt": time.Now(), "updatedAt": time.Now()},
		})
		return
	}
	backoff := []time.Duration{0, 30 * time.Second, 2 * time.Minute, 10 * time.Minute}
	d := backoff[min(job.Attempts, len(backoff)-1)]
	c.db.Collection("jobs").UpdateByID(ctx, job.ID, bson.M{
		"$set": bson.M{"state": "queued", "lastError": msg, "leaseUntil": nil,
			"nextRunAt": time.Now().Add(d), "updatedAt": time.Now()},
	})
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func (c *Crawler) handle(ctx context.Context, job *Job) error {
	switch job.Type {
	case "agency:discover":
		return c.discover(ctx, job)
	case "case:extract":
		return c.extractCase(ctx, job)
	}
	return fmt.Errorf("unknown type %s", job.Type)
}

// getCached fetches a URL unless the cache already holds it. A re-run of 50k agencies must not
// re-fetch a single page it has already read.
func (c *Crawler) getCached(ctx context.Context, rawURL string) (*Page, error) {
	var cached struct {
		Status int    `bson:"status"`
		Body   string `bson:"body"`
	}
	err := c.db.Collection("agency_pages").FindOne(ctx, bson.M{"_id": rawURL}).Decode(&cached)
	if err == nil {
		return &Page{URL: rawURL, FinalURL: rawURL, Status: cached.Status, Body: cached.Body}, nil
	}

	p, err := c.fetch.Get(ctx, rawURL)
	if err != nil {
		if err == errSkipContent {
			return p, nil
		}
		return nil, err
	}
	// Bodies are stored so extraction can be re-run and tuned without re-crawling — that iteration is
	// the whole reason this pipeline can be improved after the fact. A TTL index caps the growth.
	body := p.Body
	if len(body) > 400_000 {
		body = body[:400_000]
	}
	c.db.Collection("agency_pages").UpdateOne(ctx,
		bson.M{"_id": rawURL},
		bson.M{"$set": bson.M{"host": hostOf(rawURL), "status": p.Status, "body": body,
			"bytes": p.Bytes, "fetchedAt": time.Now()}},
		options.Update().SetUpsert(true))
	return p, nil
}

func hostOf(raw string) string {
	if u, err := url.Parse(raw); err == nil {
		return u.Hostname()
	}
	return ""
}

// agency:discover — homepage + sitemap -> the pages that list clients -> one case:extract job each.
func (c *Crawler) discover(ctx context.Context, job *Job) error {
	domain, _ := job.Payload["domain"].(string)
	if domain == "" {
		return fmt.Errorf("no domain")
	}
	base, err := url.Parse("https://" + domain)
	if err != nil {
		return err
	}

	home, err := c.getCached(ctx, base.String())
	if err != nil {
		return err
	}
	if home.Status >= 400 || home.Body == "" {
		return c.markAgency(ctx, job.RunID, domain, "unreachable", 0, fmt.Sprintf("homepage %d", home.Status))
	}

	// Sitemap is one request and, when it exists, exhaustive — far better than guessing from nav.
	var sitemap []string
	if sm, err := c.getCached(ctx, base.String()+"/sitemap.xml"); err == nil && sm.Status < 400 && sm.Body != "" {
		sitemap = ParseSitemap(sm.Body)
		// A sitemap index points at more sitemaps; follow a couple, not the whole tree.
		if len(sitemap) > 0 && strings.Contains(sm.Body, "<sitemapindex") {
			var expanded []string
			for i, s := range sitemap {
				if i >= 3 {
					break
				}
				if sub, err := c.getCached(ctx, s); err == nil && sub.Body != "" {
					expanded = append(expanded, ParseSitemap(sub.Body)...)
				}
			}
			sitemap = expanded
		}
	}

	indexes := FindCaseStudyIndexes(base, home.Body, sitemap)

	var pages []string
	for _, idx := range indexes {
		p, err := c.getCached(ctx, idx)
		if err != nil || p.Body == "" {
			continue
		}
		pages = append(pages, FindCaseStudyPages(base, p.Body, sitemap, c.maxCase)...)
		if len(pages) >= c.maxCase {
			break
		}
	}
	// Sitemap alone can carry the individual studies even when no index page was found.
	if len(pages) == 0 && len(sitemap) > 0 {
		pages = FindCaseStudyPages(base, "", sitemap, c.maxCase)
	}

	seen := map[string]bool{}
	var uniq []string
	for _, p := range pages {
		if !seen[p] && len(uniq) < c.maxCase {
			seen[p] = true
			uniq = append(uniq, p)
		}
	}

	if len(uniq) == 0 {
		// Not a failure. Plenty of agencies simply have no machine-readable case studies, and
		// retrying them four times would burn the queue for nothing.
		return c.markAgency(ctx, job.RunID, domain, "no-case-studies", 0, "")
	}

	now := time.Now()
	var docs []mongo.WriteModel
	for _, p := range uniq {
		key := fmt.Sprintf("case:extract:%s:%s", job.RunID.Hex(), p)
		docs = append(docs, mongo.NewUpdateOneModel().
			SetFilter(bson.M{"key": key}).
			SetUpsert(true).
			SetUpdate(bson.M{"$setOnInsert": bson.M{
				"key": key, "type": "case:extract",
				"payload":  bson.M{"runId": job.RunID.Hex(), "domain": domain, "url": p},
				"runId":    job.RunID,
				"priority": 10, "maxAttempts": 3, "state": "queued", "attempts": 0,
				"nextRunAt": now, "createdAt": now, "updatedAt": now,
			}}))
	}
	if len(docs) > 0 {
		if _, err := c.db.Collection("jobs").BulkWrite(ctx, docs, options.BulkWrite().SetOrdered(false)); err != nil {
			return err
		}
	}
	return c.markAgency(ctx, job.RunID, domain, "extracting", len(uniq), "")
}

func (c *Crawler) markAgency(ctx context.Context, runID primitive.ObjectID, domain, stage string, caseStudies int, errMsg string) error {
	set := bson.M{"stage": stage, "updatedAt": time.Now(), "caseStudyCount": caseStudies}
	if errMsg != "" {
		set["error"] = errMsg
	}
	_, err := c.db.Collection("agencies").UpdateOne(ctx,
		bson.M{"runId": runID, "domain": domain}, bson.M{"$set": set})
	if stage == "no-case-studies" || stage == "unreachable" {
		// Nothing further will happen for this agency, so roll it up now rather than leaving the run
		// looking permanently unfinished.
		c.enqueueRollup(ctx, runID, domain)
	}
	return err
}

func (c *Crawler) enqueueRollup(ctx context.Context, runID primitive.ObjectID, domain string) {
	now := time.Now()
	key := fmt.Sprintf("agency:rollup:%s:%s", runID.Hex(), domain)
	c.db.Collection("jobs").UpdateOne(ctx, bson.M{"key": key},
		bson.M{"$setOnInsert": bson.M{
			"key": key, "type": "agency:rollup",
			"payload":  bson.M{"runId": runID.Hex(), "domain": domain},
			"runId":    runID,
			"priority": 20, "maxAttempts": 3, "state": "queued", "attempts": 0,
			"nextRunAt": now, "createdAt": now, "updatedAt": now,
		}}, options.Update().SetUpsert(true))
}

// case:extract — one case study page -> the client behind it -> a client:scan job for the Node side.
func (c *Crawler) extractCase(ctx context.Context, job *Job) error {
	domain, _ := job.Payload["domain"].(string)
	pageURL, _ := job.Payload["url"].(string)
	if domain == "" || pageURL == "" {
		return fmt.Errorf("bad payload")
	}
	base, err := url.Parse("https://" + domain)
	if err != nil {
		return err
	}

	p, err := c.getCached(ctx, pageURL)
	if err != nil {
		return err
	}
	if p.Body == "" || p.Status >= 400 {
		return nil // read it, nothing there — not worth a retry
	}

	hit := ExtractClient(base, pageURL, p.Body)
	if hit == nil || hit.Domain == "" {
		// A name with no domain is recorded but not scanned: resolving names to domains is a separate
		// problem, and guessing here would put wrong companies in front of a prospect.
		if hit != nil && hit.Name != "" {
			c.db.Collection("clients").UpdateOne(ctx,
				bson.M{"_id": fmt.Sprintf("%s:%s:name:%s", job.RunID.Hex(), domain, hit.Name)},
				bson.M{"$setOnInsert": bson.M{
					"runId": job.RunID, "agencyDomain": domain, "clientName": hit.Name,
					"clientDomain": "", "sourceUrl": pageURL, "confidence": hit.Confidence,
					"scanned": false, "unresolved": true, "createdAt": time.Now(),
				}}, options.Update().SetUpsert(true))
		}
		c.enqueueRollup(ctx, job.RunID, domain)
		return nil
	}

	// Scoped to the RUN. A bare agency:client id is global, so a re-crawl found the document already
	// present, $setOnInsert did nothing, and the row kept the FIRST run's id — leaving the new run
	// showing zero clients while extraction was working perfectly. Cross-run scan caching does not
	// depend on this id; campaign_targets provides it, keyed by the domain itself.
	id := fmt.Sprintf("%s:%s:%s", job.RunID.Hex(), domain, hit.Domain)
	c.db.Collection("clients").UpdateOne(ctx, bson.M{"_id": id},
		bson.M{"$setOnInsert": bson.M{
			"runId": job.RunID, "agencyDomain": domain, "clientDomain": hit.Domain,
			"clientName": hit.Name, "sourceUrl": pageURL, "confidence": hit.Confidence,
			"scanned": false, "blacklistedCount": 0, "createdAt": time.Now(),
		}}, options.Update().SetUpsert(true))

	now := time.Now()
	key := fmt.Sprintf("client:scan:%s:%s", job.RunID.Hex(), id)
	c.db.Collection("jobs").UpdateOne(ctx, bson.M{"key": key},
		bson.M{"$setOnInsert": bson.M{
			"key": key, "type": "client:scan",
			"payload":  bson.M{"runId": job.RunID.Hex(), "agencyDomain": domain, "clientDomain": hit.Domain},
			"runId":    job.RunID,
			"priority": 10, "maxAttempts": 3, "state": "queued", "attempts": 0,
			"nextRunAt": now, "createdAt": now, "updatedAt": now,
		}}, options.Update().SetUpsert(true))

	c.db.Collection("agencies").UpdateOne(ctx, bson.M{"runId": job.RunID, "domain": domain},
		bson.M{"$inc": bson.M{"clientsFound": 1}, "$set": bson.M{"stage": "scanning", "updatedAt": now}})

	c.enqueueRollup(ctx, job.RunID, domain)
	return nil
}
