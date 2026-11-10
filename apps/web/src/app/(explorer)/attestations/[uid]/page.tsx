import { AttestationDetail } from './view';

export default async function Page({ params }: PageProps<'/attestations/[uid]'>) {
  const { uid } = await params;
  return <AttestationDetail uid={uid} />;
}

export async function generateMetadata({ params }: PageProps<'/attestations/[uid]'>) {
  const { uid } = await params;
  return { title: `Attestation ${uid.slice(0, 10)}...` };
}
