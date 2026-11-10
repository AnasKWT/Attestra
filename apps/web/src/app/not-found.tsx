import { ButtonLink } from '@/components/ui/primitives';

export default function NotFound() {
  return (
    <div className="relative mx-auto max-w-xl px-4 py-28 text-center sm:px-6">
      <div className="spotlight pointer-events-none absolute inset-0" />
      <p className="relative font-mono text-[13px] text-accent">404</p>
      <h1 className="relative mt-3 text-4xl font-semibold text-fg">Nothing attested here.</h1>
      <p className="relative mt-3 text-[15px] text-soft">The page does not exist. If you followed a UID, try the explorer search.</p>
      <div className="relative mt-8 flex justify-center gap-3">
        <ButtonLink href="/">Home</ButtonLink>
        <ButtonLink href="/search" variant="secondary">Search</ButtonLink>
      </div>
    </div>
  );
}
