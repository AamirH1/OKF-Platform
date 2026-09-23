import Link from 'next/link';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh place-items-center bg-muted/40 px-4 py-10">
      <div className="w-full max-w-sm">
        <Link href="/catalog" className="mb-6 flex items-center justify-center gap-2">
          <span className="grid size-8 place-items-center rounded-md bg-primary font-bold text-primary-foreground">K</span>
          <span className="text-lg font-semibold tracking-tight">OKF Platform</span>
        </Link>
        <div className="rounded-xl border bg-card p-6 shadow-sm">{children}</div>
      </div>
    </div>
  );
}
