import { SchemaDetail } from './view';

export default async function Page({ params }: PageProps<'/schemas/[uid]'>) {
  const { uid } = await params;
  return <SchemaDetail uid={uid} />;
}

export async function generateMetadata({ params }: PageProps<'/schemas/[uid]'>) {
  const { uid } = await params;
  return { title: `Schema ${uid.slice(0, 10)}...` };
}
