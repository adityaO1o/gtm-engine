// The SVG symbol sprite — rendered once at the app root; <Icon name="gauge"/> references these.
export default function IconSprite() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      <defs>
        <symbol id="i-gauge" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 12l4-3" /><circle cx="12" cy="12" r="1" /></symbol>
        <symbol id="i-users" viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0" /><path d="M16 5.2a3.2 3.2 0 0 1 0 5.6M17.5 19a5.5 5.5 0 0 0-3-4.9" /></symbol>
        <symbol id="i-inbox" viewBox="0 0 24 24"><path d="M4 13l2.5-7h11L20 13v5H4z" /><path d="M4 13h4l1.5 2.5h5L16 13h4" /></symbol>
        <symbol id="i-flag" viewBox="0 0 24 24"><path d="M6 21V4" /><path d="M6 4h11l-2 3.5L17 11H6" /></symbol>
        <symbol id="i-mega" viewBox="0 0 24 24"><path d="M4 10v4h3l8 4V6l-8 4H4z" /><path d="M18 9a4 4 0 0 1 0 6" /></symbol>
        <symbol id="i-bolt" viewBox="0 0 24 24"><path d="M13 3L4 14h6l-1 7 9-11h-6z" /></symbol>
        <symbol id="i-check" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M8.5 12.5l2.2 2.2 4.8-5.4" /></symbol>
        <symbol id="i-x" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M9 9l6 6M15 9l-6 6" /></symbol>
        <symbol id="i-shield" viewBox="0 0 24 24"><path d="M12 3l7 3v5.5c0 4.2-2.9 7.9-7 9.5-4.1-1.6-7-5.3-7-9.5V6z" /><path d="M9 12l2 2 4-4.5" /></symbol>
        <symbol id="i-mail" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" /><path d="M3 6l9 7 9-7" /></symbol>
        <symbol id="i-warn" viewBox="0 0 24 24"><path d="M12 3l9 16H3z" /><path d="M12 9v5M12 17v.5" /></symbol>
        <symbol id="i-trend" viewBox="0 0 24 24"><path d="M4 15l5-5 3 3 6-7" /><path d="M15 6h4v4" /></symbol>
        <symbol id="i-download" viewBox="0 0 24 24"><path d="M12 4v10m0 0l-4-4m4 4l4-4" /><path d="M5 19h14" /></symbol>
        <symbol id="i-refresh" viewBox="0 0 24 24"><path d="M4 12a8 8 0 0 1 14-5l2 2M20 12a8 8 0 0 1-14 5l-2-2" /><path d="M20 4v5h-5M4 20v-5h5" /></symbol>
        <symbol id="i-pause" viewBox="0 0 24 24"><rect x="7" y="5" width="3.5" height="14" /><rect x="13.5" y="5" width="3.5" height="14" /></symbol>
        <symbol id="i-chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" /></symbol>
        <symbol id="i-back" viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6" /></symbol>
        <symbol id="i-external" viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-8 8M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" /></symbol>
        <symbol id="i-sync" viewBox="0 0 24 24"><path d="M20 8a8 8 0 0 0-14-3M4 6v3h3" /><path d="M4 16a8 8 0 0 0 14 3M20 18v-3h-3" /></symbol>
        <symbol id="i-spark" viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /></symbol>
        <symbol id="i-radio" viewBox="0 0 24 24"><circle cx="12" cy="12" r="2.3" /><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M6 6a8.5 8.5 0 0 0 0 12M18 6a8.5 8.5 0 0 1 0 12" /></symbol>
        <symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></symbol>
        <symbol id="i-trash" viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" /></symbol>
        <symbol id="i-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19" /></symbol>
        <symbol id="i-moon" viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5z" /></symbol>
        <symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></symbol>
      </defs>
    </svg>
  );
}
