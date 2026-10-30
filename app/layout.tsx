import "./globals.css";

// No font is downloaded at build or at run time: a build must not depend on an outside service. The stack is in
// globals.css: the brand's typefaces when the device has them, the system's sans-serif otherwise.
export const metadata = {
  title: "LUXIA Identity",
  description: "Gouvernance des identités et des accès, par LUXIA-IT",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body className="antialiased min-h-screen">
        {children}
      </body>
    </html>
  );
}
