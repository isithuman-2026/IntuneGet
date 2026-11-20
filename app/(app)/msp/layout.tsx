import { AccessGate } from '@/components/auth/AccessGate';

export default function MspLayout({ children }: { children: React.ReactNode }) {
  return <AccessGate>{children}</AccessGate>;
}
