import type {ExampleType, FeatureGroup} from '@tsp/contracts';

/**
 * The feature catalogue is fixed in code (tech doc §2). Video and photo&text share a
 * placeholder key when the display name matches, but the data behind it differs per type,
 * so a feature is always ticked per type.
 */
export interface FeatureDef {
  key: string;
  label: string;
  isImage: boolean;
}

const f = (label: string, isImage = false): FeatureDef => ({key: label.replace(/[ &]+/g, '_'), label, isImage});

export const FEATURES: Record<FeatureGroup, FeatureDef[]> = {
  video: [
    f('Description'),
    f('OCR Text'),
    f('Frame', true),
    f('Cover', true),
    f('ASR'),
    f('Creator Nick Name'),
    f('Creator Bio'),
    f('Creator Avatar', true),
  ],
  photo_text: [
    f('Title'),
    f('Description'),
    f('OCR Text'),
    f('Images', true),
    f('Cover', true),
    f('ASR'),
    f('Creator Nick Name'),
    f('Creator Bio'),
    f('Creator Avatar', true),
  ],
  metadata: [
    f('Hashtags'),
    f('Create Time'),
    f('Country Code'),
    f('POI Name'),
    f('POI Info'),
    f('Interest V3'),
    f('Language'),
    f('Intelligence POI'),
    f('Summary'),
    f('Effective Info'),
  ],
};

/** Rows of the Features panel: every item key in display order, with the types that have it. */
export const ITEM_ROWS: {key: string; label: string; video: boolean; photo_text: boolean}[] = (() => {
  const order = ['Title', 'Description', 'OCR_Text', 'Frame', 'Images', 'Cover', 'ASR', 'Creator_Nick_Name', 'Creator_Bio', 'Creator_Avatar'];
  return order.map(key => {
    const def = [...FEATURES.video, ...FEATURES.photo_text].find(d => d.key === key)!;
    return {
      key,
      label: def.label,
      video: FEATURES.video.some(d => d.key === key),
      photo_text: FEATURES.photo_text.some(d => d.key === key),
    };
  });
})();

export const ALL_KEYS: string[] = [...new Set(Object.values(FEATURES).flat().map(d => d.key))];

export function featureDef(group: FeatureGroup, key: string): FeatureDef | undefined {
  return FEATURES[group].find(d => d.key === key);
}

export function isImageKey(key: string): boolean {
  return Object.values(FEATURES).some(list => list.some(d => d.key === key && d.isImage));
}

export function labelOf(key: string): string {
  return Object.values(FEATURES).flat().find(d => d.key === key)?.label ?? key;
}

export const TYPE_LABEL: Record<ExampleType, string> = {video: 'Video', photo_text: 'Photo&text'};
