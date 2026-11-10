import { AuthorityDetail } from './view';

export default async function Page({ params }: PageProps<'/authorities/[account]'>) {
  const { account } = await params;
  return <AuthorityDetail account={decodeURIComponent(account)} />;
}

export async function generateMetadata({ params }: PageProps<'/authorities/[account]'>) {
  const { account } = await params;
  return { title: `Authority ${decodeURIComponent(account)}` };
}
