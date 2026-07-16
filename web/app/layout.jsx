import "./globals.css";
import IconSprite from "@/components/IconSprite";

export const metadata = { title: "InboxKit GTM Engine" };

// Preload the main faces so the swap is near-instant (fonts are served by Express at /fonts).
const FONTS = ["SuisseIntlTrial-Regular.otf", "SuisseIntlTrial-Medium.otf", "SuisseIntlTrial-Semibold.otf", "SuisseIntlMonoTrial-Regular.otf"];
// Apply the saved theme before first paint — no light→dark flash. CSP allows inline scripts.
const THEME_INIT = "try{var t=localStorage.getItem('theme');if(t)document.documentElement.setAttribute('data-theme',t)}catch(e){}";

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
        {FONTS.map((f) => <link key={f} rel="preload" href={`/fonts/${f}`} as="font" type="font/otf" crossOrigin="anonymous" />)}
        <IconSprite />
        {children}
      </body>
    </html>
  );
}
