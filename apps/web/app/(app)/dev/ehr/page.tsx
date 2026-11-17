import { notFound } from 'next/navigation';
import { devToolsEnabled } from '@/lib/dev-tools';
import { DevEhrPanel } from './DevEhrPanel';

/** DEV ONLY: mock EHR controls. Returns 404 outside development. */
export default function DevEhrPage() {
  if (!devToolsEnabled) notFound();
  return <DevEhrPanel />;
}
