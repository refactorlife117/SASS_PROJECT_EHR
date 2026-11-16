import { notFound } from 'next/navigation';
import { DevEhrPanel } from './DevEhrPanel';

/** DEV ONLY: mock EHR controls. Returns 404 outside development. */
export default function DevEhrPage() {
  if (process.env.NODE_ENV !== 'development') notFound();
  return <DevEhrPanel />;
}
