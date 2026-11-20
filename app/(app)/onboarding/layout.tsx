import type { Metadata } from 'next';
import { AccessGate } from '@/components/auth/AccessGate';

export const metadata: Metadata = {
  title: 'Setup | IntuneGet',
  description: 'Complete your organization setup to start deploying apps to Intune',
};

export default function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AccessGate>
      <div className="min-h-screen bg-bg-deepest">
        {children}
      </div>
    </AccessGate>
  );
}
