/** Mockup-A frame shared by sign-in, not-authorised and loading states. */
export function AuthShell({ children, subtitle }: { children: React.ReactNode; subtitle?: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#f4f6f8] px-4 py-10 text-[#0f172a] font-sans">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 text-center">
          <div
            className="text-2xl font-semibold tracking-tight"
            style={{ fontFamily: '"Space Grotesk", var(--font-inter), sans-serif' }}
          >
            Intune<span className="text-[#0e7490]">Get</span>
          </div>
          {subtitle && <p className="mt-1 text-sm text-[#475569]">{subtitle}</p>}
        </div>
        <div className="rounded-[12px] border border-[#e2e8f0] bg-white p-8 shadow-sm">{children}</div>
      </div>
    </div>
  );
}

export function AuthShellSpinner() {
  return (
    <AuthShell>
      <div className="flex justify-center py-6" role="status" aria-label="Loading">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-[#e2e8f0] border-t-[#0e7490]" />
      </div>
    </AuthShell>
  );
}
