'use client';

import {useEffect, useState} from 'react';
import {Button, Heading, HStack, Icon, Link, Text, TextArea, VStack} from '@/ui/astryx';
import {ArrowTopRightOnSquareIcon, CheckCircleIcon, LockClosedIcon} from '@heroicons/react/24/outline';
import type {PermissionPoint} from '@yushiguang/sprint-contracts';
import {requestAccess} from '@/backend-api';
import {accessDeniedProject, accessDeniedText, clearAccessDenied, useAccessDenied} from '@/ui';
import {t} from '@/i18n';
import {useRuntime} from '../session';
import {FormDialog} from './dialogs';

/**
 * The "insufficient access" dialog (wireframes W-NoAccess, W-NoAccess-Source, W-NoAccess-Sent):
 * shown when something the user did was refused for a missing permission point. Sprint approves
 * nothing itself: Request access sends the request, with an optional reason, to the external
 * permission platform, and the sent dialog links to it when the platform has a page for it.
 */
export function NoAccessHost({project}: {project?: {id: string; name: string}}) {
  const denied = useAccessDenied();
  // Leaving the page that was refused closes the dialog.
  useEffect(() => clearAccessDenied, []);
  if (!denied) return null;
  return <NoAccessDialog key={denied} permission={denied} project={accessDeniedProject() ?? project} onClose={clearAccessDenied} />;
}

function NoAccessDialog({permission, project, onClose}: {permission: PermissionPoint; project?: {id: string; name: string}; onClose: () => void}) {
  const {info} = useRuntime();
  const tenant = info?.tenant?.name ?? '';
  const redirectMode = info?.accessRequestMode === 'redirect';
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [sent, setSent] = useState<{trackUrl?: string; applyUrl?: string} | null>(null);
  const text = {...words(permission, tenant, permission === 'project_write' ? project?.name : undefined), ...accessDeniedText()};

  const send = async () => {
    // Redirect mode (#120, W-NoAccess-Redirect): the platform's form opens in a new tab. The tab is
    // opened now, inside the click, because browsers block a window opened after a network wait;
    // it is pointed at the form once Sprint has the link, or closed again if there is none.
    const tab = redirectMode ? window.open('', '_blank') : null;
    setSending(true);
    setFailed(null);
    try {
      const res = await requestAccess({
        permission,
        ...(permission === 'project_write' && project ? {projectId: project.id} : {}),
        ...(!redirectMode && reason.trim() ? {reason: reason.trim()} : {}),
      });
      const url = res.applyUrl && /^https?:\/\//i.test(res.applyUrl) ? res.applyUrl : undefined;
      if (tab && url) {
        tab.opener = null;
        tab.location.href = url;
        return onClose();
      }
      tab?.close();
      setSent(res);
    } catch (e) {
      tab?.close();
      const msg = e instanceof Error ? e.message : '';
      setFailed(/^[A-Z][^{}<>\n]{0,160}\.$/.test(msg) ? t(msg) : t('Check your connection and try again.'));
    } finally {
      setSending(false);
    }
  };

  const applyUrl = sent?.applyUrl && /^https?:\/\//i.test(sent.applyUrl) ? sent.applyUrl : undefined;
  if (sent && applyUrl)
    return (
      <FormDialog
        width={480}
        onClose={onClose}
        title={
          <HStack gap={2} vAlign="center">
            <Icon icon={ArrowTopRightOnSquareIcon} size="md" color="secondary" />
            <Heading level={3}>{t('Continue on the permission platform')}</Heading>
          </HStack>
        }
        footer={<Button label={t('Done')} variant="primary" onClick={onClose} />}
      >
        <VStack gap={3}>
          <Text type="body" color="secondary">
            {t('Finish your request for {need} on the permission platform. Come back here once it is approved.', {need: text.need})}
          </Text>
          <Link href={applyUrl} target="_blank" rel="noopener noreferrer">
            <HStack as="span" gap={1} vAlign="center">
              {t('Open the permission platform')}
              <Icon icon={ArrowTopRightOnSquareIcon} size="sm" color="inherit" />
            </HStack>
          </Link>
        </VStack>
      </FormDialog>
    );

  if (sent)
    return (
      <FormDialog
        width={480}
        onClose={onClose}
        title={
          <HStack gap={2} vAlign="center">
            <Icon icon={CheckCircleIcon} size="md" color="success" />
            <Heading level={3}>{t('Request sent')}</Heading>
          </HStack>
        }
        footer={<Button label={t('Done')} variant="primary" onClick={onClose} />}
      >
        <VStack gap={3}>
          <Text type="body" color="secondary">
            {t('Your request for {need} is waiting for approval. You can use it as soon as it is approved.', {need: text.need})}
          </Text>
          {sent.trackUrl && (
            <Link href={sent.trackUrl} target="_blank" rel="noreferrer">
              <HStack as="span" gap={1} vAlign="center">
                {t('Track it on the permission platform')}
                <Icon icon={ArrowTopRightOnSquareIcon} size="sm" color="inherit" />
              </HStack>
            </Link>
          )}
        </VStack>
      </FormDialog>
    );

  return (
    <FormDialog
      width={480}
      onClose={onClose}
      title={
        <HStack gap={2} vAlign="center">
          <Icon icon={LockClosedIcon} size="md" color="secondary" />
          <Heading level={3}>{text.title}</Heading>
        </HStack>
      }
      footer={
        <>
          <Button label={t('Cancel')} variant="ghost" onClick={onClose} />
          <Button
            label={redirectMode ? t('Request on the permission platform') : t('Request access')}
            variant="primary"
            endContent={redirectMode ? <Icon icon={ArrowTopRightOnSquareIcon} size="sm" color="inherit" /> : undefined}
            isLoading={sending}
            onClick={() => void send()}
          />
        </>
      }
    >
      <VStack gap={5}>
        <Text type="body" color="secondary">
          {text.why}
        </Text>
        <VStack gap={1}>
          <Text type="supporting" color="secondary">
            {t('You are asking for')}
          </Text>
          <Text type="label">{text.need}</Text>
        </VStack>
        {redirectMode ? (
          <Text type="supporting" color="secondary">
            {t('The request form opens in a new tab. Come back here once it is approved.')}
          </Text>
        ) : (
          <TextArea label={t('Why you need it')} isOptional value={reason} onChange={setReason} placeholder={t("For example: I'm labeling the Food examples this week")} rows={3} />
        )}
        {failed && (
          <Text type="supporting" className="sp-error" role="alert">
            {t(redirectMode ? 'Could not open the permission platform. {why}' : 'The request was not sent. {why}', {why: failed})}
          </Text>
        )}
      </VStack>
    </FormDialog>
  );
}

/** The dialog's words for each permission point. */
function words(permission: PermissionPoint, tenant: string, project?: string): {title: string; why: string; need: string} {
  if (permission === 'project_write')
    return {
      title: t("You can't edit this project"),
      why: t('Everyone in {tenant} can view it. Editing needs edit access to this project, tenant admins included.', {tenant}),
      need: project ? t('Edit · {project}', {project}) : t('Edit access to this project'),
    };
  if (permission === 'tenant_write')
    return {
      title: t('This needs admin access'),
      why: t('Everyone in {tenant} can view this. Only its admins can change it.', {tenant}),
      need: t('Admin · {tenant}', {tenant}),
    };
  return {
    title: t("You can't open this"),
    why: t('Only members of {tenant} can see it.', {tenant}),
    need: t('Member · {tenant}', {tenant}),
  };
}
