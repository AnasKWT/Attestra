import { SearchView } from '@/components/explorer/SearchView';

export const metadata = { title: 'Search' };

export default async function SearchPage({ searchParams }: PageProps<'/search'>) {
  const q = (await searchParams).q;
  return (
    <div className="mx-auto max-w-3xl px-4 py-14 sm:px-6">
      <h1 className="text-3xl font-semibold text-fg">Search</h1>
      <p className="mt-2 text-[14.5px] text-soft">Schemas, attestations, authorities and accounts.</p>
      <div className="mt-8">
        <SearchView initial={typeof q === 'string' ? q : ''} />
      </div>
    </div>
  );
}
