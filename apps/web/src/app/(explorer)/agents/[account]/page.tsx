import { AgentDetail } from './view';

export default async function Page({ params }: PageProps<'/agents/[account]'>) {
  const { account } = await params;
  return <AgentDetail account={decodeURIComponent(account)} />;
}

export async function generateMetadata({ params }: PageProps<'/agents/[account]'>) {
  const { account } = await params;
  return { title: `Agent ${decodeURIComponent(account)}` };
}
