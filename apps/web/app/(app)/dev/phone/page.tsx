import { notFound } from 'next/navigation';
import { devToolsEnabled } from '@/lib/dev-tools';
import { DevPhonePanel } from './DevPhonePanel';

/** DEV ONLY: simulated patient phones. Returns 404 outside development. */
export default function DevPhonePage() {
  if (!devToolsEnabled) notFound();
  return <DevPhonePanel />;
}
