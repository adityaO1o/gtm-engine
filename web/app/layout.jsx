import "./globals.css";
import IconSprite from "@/components/IconSprite";

export const metadata = {
  title: "InboxKit GTM Engine",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <IconSprite />
        {children}
      </body>
    </html>
  );
}
