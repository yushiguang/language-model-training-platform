'use client';

import {Badge} from '@astryxdesign/core/Badge';
import {HStack, VStack} from '@astryxdesign/core/Layout';
import {Text} from '@astryxdesign/core/Text';
import {useLocale} from '@/i18n/LocaleProvider';
import {t} from '@/i18n/text';
import type {Post} from '@/mock/posts';

const FRAME_TIMES = ['0:00', '0:04', '0:09', '0:15'];

/** A post as labelers and the agent see it: frames, title, OCR, ASR and creator, in its own language. */
export function PostPreview({post, isCompact = false}: {post: Post; isCompact?: boolean}) {
  const {tr} = useLocale();
  return (
    <VStack gap={2} className="post">
      <div className="frames" aria-label={tr(t('Sampled video frames', '抽取的视频帧'))}>
        {(isCompact ? FRAME_TIMES.slice(0, 3) : FRAME_TIMES).map((time, i) => (
          <div
            key={time}
            className="frame"
            style={{background: `linear-gradient(135deg, hsl(${post.hue + i * 12} 55% 72%), hsl(${post.hue + 40 + i * 8} 45% 48%))`}}>
            <span className="frame-time">{time}</span>
          </div>
        ))}
      </div>
      <HStack gap={1.5} wrap="wrap" align="center">
        <Badge label={post.lang.toUpperCase()} variant="neutral" />
        <Text type="supporting" color="secondary">
          {tr(post.country)} · @{post.creator.nickname}
        </Text>
      </HStack>
      <div dir="auto" lang={post.lang}>
        <Text weight="semibold">{post.title}</Text>
      </div>
      <Text type="supporting" color="secondary">
        {tr(post.gloss)}
      </Text>
      {!isCompact && (
        <dl className="post-fields">
          <dt>OCR</dt>
          <dd dir="auto" lang={post.lang}>
            {post.ocr}
          </dd>
          <dt>ASR</dt>
          <dd dir="auto" lang={post.lang}>
            {post.asr}
          </dd>
          <dt>{tr(t('Creator bio', '作者简介'))}</dt>
          <dd dir="auto" lang={post.lang}>
            {post.creator.bio}
          </dd>
        </dl>
      )}
    </VStack>
  );
}
