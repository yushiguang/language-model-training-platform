'use client';

import {Children, Fragment, useId, type ComponentType, type ReactNode, type SVGProps} from 'react';
import {Card, Dialog, Divider, Heading, HStack, Icon, IconButton, Layout, LayoutContent, SideNav, SideNavItem, SideNavSection, StackItem, Text, VStack} from '@/ui/astryx';
import {XMarkIcon} from '@heroicons/react/24/outline';
import {t} from '@/i18n';

/**
 * Shared dialogs (wireframes v346, batch 2): one look for every form dialog (create project,
 * optimise, stop, no access) and one for both settings dialogs (project and tenant).
 */

type HeroIcon = ComponentType<SVGProps<SVGSVGElement>>;

function CloseButton({onClose}: {onClose: () => void}) {
  return <IconButton label={t('Close')} variant="ghost" size="sm" icon={<Icon icon={XMarkIcon} size="sm" />} onClick={onClose} />;
}

/** Header (title, close), body, and a footer of buttons on the right. */
export function FormDialog({
  title,
  onClose,
  footer,
  width = 560,
  noClose,
  children,
}: {
  title: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  width?: number;
  /** For a dialog that must be answered with one of its buttons. */
  noClose?: boolean;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <Dialog isOpen onOpenChange={open => !open && onClose()} purpose="form" width={width} padding={0} aria-labelledby={titleId}>
      <VStack gap={0}>
        <HStack gap={3} vAlign="center" hAlign="between" className="sp-dlg-head">
          <span id={titleId} className="sp-dlg-title">
            {typeof title === 'string' ? <Heading level={3}>{title}</Heading> : title}
          </span>
          {!noClose && <CloseButton onClose={onClose} />}
        </HStack>
        <div className="sp-dlg-body">{children}</div>
        {footer && (
          <HStack gap={2} hAlign="end" vAlign="center" className="sp-dlg-foot">
            {footer}
          </HStack>
        )}
      </VStack>
    </Dialog>
  );
}

export interface SettingsSection<K extends string> {
  title?: string;
  items: {key: K; label: string; icon: HeroIcon; end?: string}[];
}

/** Settings in a dialog: sections on the left, the chosen one on the right, Save in the footer. */
export function SettingsDialog<K extends string>({
  title,
  sections,
  selected,
  onSelect,
  heading,
  sub,
  onClose,
  footer,
  children,
}: {
  title: string;
  sections: SettingsSection<K>[];
  selected: K;
  onSelect: (key: K) => void;
  heading: string;
  sub?: string;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Dialog isOpen onOpenChange={open => !open && onClose()} purpose="form" width={960} padding={0} aria-label={title}>
      <div className="sp-settings">
        <Layout
          start={
            <SideNav
              aria-label={t('{title} sections', {title})}
              header={
                <HStack gap={2} paddingInline={2} minHeight={32} vAlign="center">
                  <Heading level={4}>{title}</Heading>
                </HStack>
              }
            >
              {sections.map((s, i) => {
                const items = s.items.map(it => (
                  <SideNavItem
                    key={it.key}
                    label={it.label}
                    icon={<Icon icon={it.icon} size="sm" />}
                    isSelected={it.key === selected}
                    onClick={() => onSelect(it.key)}
                    endContent={
                      it.end ? (
                        <Text type="supporting" color="secondary">
                          {it.end}
                        </Text>
                      ) : undefined
                    }
                  />
                ));
                return s.title ? (
                  <SideNavSection key={i} title={s.title}>
                    {items}
                  </SideNavSection>
                ) : (
                  <Fragment key={i}>{items}</Fragment>
                );
              })}
            </SideNav>
          }
          content={
            <LayoutContent isScrollable padding={0}>
              <div className="sp-settings-main">
                <div className="sp-settings-body">
                  <VStack gap={5}>
                    <HStack gap={2} vAlign="start">
                      <StackItem size="fill">
                        <VStack gap={0.5}>
                          <Heading level={2}>{heading}</Heading>
                          {sub && (
                            <Text type="supporting" color="secondary">
                              {sub}
                            </Text>
                          )}
                        </VStack>
                      </StackItem>
                      <CloseButton onClose={onClose} />
                    </HStack>
                    {children}
                  </VStack>
                </div>
                {footer && (
                  <HStack gap={2} hAlign="end" className="sp-settings-foot">
                    {footer}
                  </HStack>
                )}
              </div>
            </LayoutContent>
          }
        />
      </div>
    </Dialog>
  );
}

/** A group of settings rows in one muted card, with a small title above it. `danger`: a red outline. */
export function SettingsCard({title, hint, action, danger, children}: {title?: string; hint?: string; action?: ReactNode; danger?: boolean; children: ReactNode}) {
  const rows = Children.toArray(children);
  return (
    <VStack gap={1.5}>
      {title != null && (
        <HStack gap={2} vAlign="center" hAlign="between">
          <Text type="supporting" weight="semibold" color="secondary">
            {title}
          </Text>
          {hint && (
            <Text type="supporting" color="secondary">
              {hint}
            </Text>
          )}
          {action}
        </HStack>
      )}
      <Card padding={0} width="100%" variant={danger ? undefined : 'muted'} className={danger ? 'sp-danger-card' : undefined}>
        <VStack gap={0}>
          {rows.map((r, i) => (
            <VStack key={i} gap={0}>
              {i > 0 && <Divider variant="subtle" />}
              {r}
            </VStack>
          ))}
        </VStack>
      </Card>
    </VStack>
  );
}

/** One setting: its title and a short line on the left, its control on the right. */
export function SettingsRow({
  title,
  description,
  icon,
  start,
  control,
  controlWidth = 220,
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: HeroIcon;
  /** Instead of the icon: an avatar or a checkbox. */
  start?: ReactNode;
  control?: ReactNode;
  controlWidth?: number | 'auto';
}) {
  return (
    <HStack padding={4} gap={3} vAlign="center" className="sp-settings-row">
      <StackItem size="fill" style={{minWidth: 0}}>
        <HStack gap={start ? 3 : 2} vAlign={start ? 'center' : 'start'}>
          {start}
          {icon && !start && (
            <VStack paddingBlockStart={0.5}>
              <Icon icon={icon} size="sm" color="secondary" />
            </VStack>
          )}
          <VStack gap={0.5} style={{minWidth: 0, flex: 1}}>
            {typeof title === 'string' ? <Text type="label">{title}</Text> : title}
            {description &&
              (typeof description === 'string' ? (
                <Text type="supporting" color="secondary">
                  {description}
                </Text>
              ) : (
                description
              ))}
          </VStack>
        </HStack>
      </StackItem>
      {control && (
        <div className="sp-settings-control" style={controlWidth === 'auto' ? undefined : {width: controlWidth}}>
          {control}
        </div>
      )}
    </HStack>
  );
}
