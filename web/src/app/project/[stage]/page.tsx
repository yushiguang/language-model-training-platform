import {STAGES} from '@/mock/stages';
import {StagePage} from './StagePage';

export function generateStaticParams() {
  return STAGES.map(stage => ({stage: stage.slug}));
}

export default async function Page({params}: {params: Promise<{stage: string}>}) {
  const {stage} = await params;
  return <StagePage slug={stage} />;
}
