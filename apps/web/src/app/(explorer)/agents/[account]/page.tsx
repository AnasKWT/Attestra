import { AgentDetail } from './view';

export default async function Page({ params }: PageProps<'/agents/[account]'>) {
  const { account } = await params;
  return <AgentDetail account={decodeURIComponent(account)} />;
}
