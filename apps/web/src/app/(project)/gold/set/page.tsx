'use client';

import {EmptyState} from '@/ui/astryx';
import type {PageContext} from '@yushiguang/sprint-contracts';
import {Frame, ProjectPage} from '@/components/Shell';
import {hrefFor} from '@/components/ProjectContext';
import {PageTitle} from '@/ui';
import {t} from '@/i18n';

/**
 * One label set (wireframes W-Gold-Set): the examples one person labels. The route is here so the
 * step bar, the back link and Ask AI work; the Gold Labels lane builds the page.
 */
export default function LabelSetPage() {
  return (
    <ProjectPage node="gold" page={PAGE}>
      {({state}) => (
        <Frame head={<PageTitle title={t('Label set')} back={{label: t('Gold Labels'), href: hrefFor(state.project.id, '/gold')}} />}>
          <EmptyState title={t('This page is on its way')} description={t('Label sets open here once they are ready. Until then, label on Gold Labels.')} />
        </Frame>
      )}
    </ProjectPage>
  );
}

const PAGE: PageContext = {label: 'Gold Labels', agent: 'front_desk', intent: 'answer', context: {}};
