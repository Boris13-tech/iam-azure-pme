const fs = require('fs');
let p = fs.readFileSync('app/login/page.tsx', 'utf8');
p = p.replace('export default async function LoginPage({ searchParams }: { searchParams: { error?: string } }) {', 'export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {\n  const sp = await searchParams;');
p = p.replace('const errorMsg = searchParams?.error || \"\";', 'const errorMsg = sp?.error || \"\";');
fs.writeFileSync('app/login/page.tsx', p);
