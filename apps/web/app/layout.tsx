import "./globals.css";
import type { ReactNode } from "react";

import { Nav } from "../components/Nav";

export const metadata = {
  title: "FeedEater",
  description: "Single pane of glass for your post-human feeds",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="container">
          <Nav />
          <div style={{ height: 16 }} />
          {children}
        </div>
      </body>
    </html>
  );
}
