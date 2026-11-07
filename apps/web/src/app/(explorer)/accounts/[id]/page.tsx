import { AccountView } from '@/components/explorer/AccountView';

export default async function Page({ params }: PageProps<'/accounts/[id]'>) {
  const { id } = await params;
  return <AccountView id={decodeURIComponent(id)} />;
}
