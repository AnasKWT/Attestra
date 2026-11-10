import { ButtonLink } from '@/components/ui/primitives';

export default function NotFound() {
  return (
    <div className="mx-auto max-w-xl px-4 py-28 text-center sm:px-6">
      <p className="font-mono text-[13px] text-mute">404</p>
      <h1 className="mt-3 text-4xl font-semibold tracking-tight text-fg">Nothing attested here.</h1>
      <p className="mt-3 text-[15px] text-soft">The page does not exist. If you followed a UID, try the explorer search.</p>
      <div className="mt-8 flex justify-center gap-3">
        <ButtonLink href="/">Home</ButtonLink>
        <ButtonLink href="/search" variant="secondary">Search</ButtonLink>
      </div>
    </div>
  );
}
