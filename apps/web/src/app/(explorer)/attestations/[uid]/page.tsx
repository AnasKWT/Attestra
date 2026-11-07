import { AttestationDetail } from './view';

export default async function Page({ params }: PageProps<'/attestations/[uid]'>) {
  const { uid } = await params;
  return <AttestationDetail uid={uid} />;
}
