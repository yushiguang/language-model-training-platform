import type {FeatureInfo, FeatureInfoSource} from '@tsp/contracts';

/**
 * Stand-in feature descriptions, made up for the public repository. The internal build provides
 * the real ones through `Platform.featureInfo` (docs/handover/integration.md, "Feature
 * descriptions"). The agents read them with the read_feature_info tool.
 */
const MADE_UP: Record<string, FeatureInfo> = {
  Title: {description: 'The title the poster wrote.', goodFor: 'What the post is about, in the poster’s words.', caveats: 'Often short or empty.'},
  Description: {description: 'The caption under the post.', goodFor: 'The poster’s intent, hashtags in the text, ad disclosures.', caveats: 'Can be long; may repeat the title.'},
  OCR_Text: {description: 'Text read from the frames or images by OCR.', goodFor: 'Prices, shop links and captions shown on screen.', caveats: 'Noisy; repeated lines are common; often empty when nothing is written on screen.'},
  Frame: {description: 'A few still frames taken from the video.', goodFor: 'What is shown when the text says little.', caveats: 'Images cost more per call than text.'},
  Images: {description: 'The images of a photo-and-text post.', goodFor: 'What is shown when the text says little.', caveats: 'Images cost more per call than text.'},
  Cover: {description: 'The cover image the poster chose.', goodFor: 'A quick look at the topic.', caveats: 'Often a styled thumbnail, not the content; costs like any image.'},
  ASR: {description: 'Speech in the video, as text.', goodFor: 'Tutorials, reviews and talk where the speech carries the point.', caveats: 'Empty for music-only videos; may mix languages.'},
  Creator_Nick_Name: {description: 'The poster’s display name.', goodFor: 'Spotting brand or shop accounts.', caveats: 'Rarely helps on its own.'},
  Creator_Bio: {description: 'The poster’s profile text.', goodFor: 'Spotting shops, agencies and news accounts.', caveats: 'Often empty.'},
  Creator_Avatar: {description: 'The poster’s profile picture.', goodFor: 'Brand logos.', caveats: 'Costs like any image; rarely helps.'},
  Hashtags: {description: 'The post’s hashtags.', goodFor: 'Topic and ad tags such as #ad.', caveats: 'Can be spammy and unrelated.'},
  Create_Time: {description: 'When the post was made.', goodFor: 'Events and seasons.', caveats: 'Rarely matters for labels.'},
  Country_Code: {description: 'The country the post comes from.', goodFor: 'Region-specific rules.'},
  POI_Name: {description: 'The name of a tagged place.', goodFor: 'Places, venues and travel posts.', caveats: 'Missing on most posts.'},
  POI_Info: {description: 'Details of a tagged place.', goodFor: 'The kind of place (restaurant, shop, park).', caveats: 'Missing on most posts.'},
  Interest_V3: {description: 'Interest categories predicted for the post.', goodFor: 'A first guess at topics.', caveats: 'A model’s guess, not a label.'},
  Language: {description: 'The language of the post.', goodFor: 'Language-specific rules.'},
  Intelligence_POI: {description: 'A place guessed from the content.', goodFor: 'Places when nothing is tagged.', caveats: 'A guess; can be wrong.'},
  Summary: {description: 'A short summary of the post written by a model.', goodFor: 'A quick read of long posts.', caveats: 'A model’s words, may miss details.'},
  Effective_Info: {description: 'Key facts pulled from the post.', goodFor: 'Prices, offers and contact details.', caveats: 'Often empty.'},
};

export function sampleFeatureInfo(): FeatureInfoSource {
  return {
    describe: async keys => Object.fromEntries(keys.filter(k => MADE_UP[k]).map(k => [k, MADE_UP[k]])),
  };
}
