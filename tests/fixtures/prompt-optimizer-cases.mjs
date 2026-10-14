/** 固定文字验收素材；不是真实附件，不运行画图/视频/数字人工具。 */
const rows = [
  ['general-cn', 'general', 'zh', JSON.stringify({ task: '核对两行文本，不执行代码', state: 'pending', quote: '保持“甲”', path: String.raw`C:\refs\iris`, literal: String.raw`\n | \" | \\ | \u4e00` }), 'pending', 'done', ['json', 'quotes', 'path', 'backslashes']],
  ['general-en', 'general', 'en', 'Review the following code without running it.\n```js\nconst state = "pending";\nconst literal = "\\\\n";\n```\nKeep both lines and the code fence.', 'pending', 'done', ['code', 'newlines', 'backslashes']],
  ['image-cn', 'image', 'zh', '画两只白色的猫：左边坐着，右边站着。不要帽子或多余肢体。保留引文“琉璃色”和比例 4:3。', '白色', '黑色', ['count', 'directions', 'negation', 'quotation', 'ratio']],
  ['image-en', 'image', 'en', 'Draw two white cats: the cat on the left sits, the one on the right stands. No hats or extra limbs. Keep the quotation "琉璃色" and aspect ratio 4:3.', 'white', 'black', ['count', 'directions', 'negation', 'quotation', 'ratio']],
  ['image-edit-cn', 'image-edit', 'zh', '图像来源为 source-A。只调整右侧对象的蓝色上衣；保持左侧对象、身份、背景和原有构图，不重新生成整张图。', '蓝色', '绿色', ['reference', 'directions', 'scope', 'negation']],
  ['image-edit-en', 'image-edit', 'en', 'Use source-A as the image reference. Adjust only the blue shirt of the object on the right. Keep the object on the left, identity, background, and composition. Do not recreate the whole image.', 'blue', 'green', ['reference', 'directions', 'scope', 'negation']],
  ['video-cn', 'video', 'zh', '视频长 6 秒。人物先抬起右手，然后放下。若光线不足，保持原场景，不增加闪光或额外镜头。不要新台词。', '6 秒', '8 秒', ['number', 'time-order', 'condition', 'directions', 'negation']],
  ['video-en', 'video', 'en', 'The video lasts 6 seconds. First raise the right hand, then lower it. If light is insufficient, keep the original scene; add no flashes or extra shots. No new dialogue.', '6 seconds', '8 seconds', ['number', 'time-order', 'condition', 'directions', 'negation']],
  ['s2v-cn', 's2v', 'zh', '首帧图像与已有音频为既定输入。人物穿白色衬衫，口型跟随已有音频。保持身份、背景和动作连续性；不添加新台词、新声音或首尾帧插值。', '白色', '黑色', ['first-frame-audio', 'identity', 'negation']],
  ['s2v-en', 's2v', 'en', 'Use the existing first-frame image and audio. The person wears a white shirt; lip movements follow the existing audio. Keep identity, background, and motion continuity. Add no new dialogue, sound, or first/last-frame interpolation.', 'white', 'black', ['first-frame-audio', 'identity', 'negation']]
];

export const PROMPT_REWRITE_CASES = Object.freeze(rows.map(([id, target, language, text, from, to, tags]) => {
  if (text.split(from).length !== 2) throw new Error('样例的授权替换必须恰好出现一次：' + id);
  const rule = language === 'zh' ? `只把 ${from} 改为 ${to}，其余每个字符逐字保留，包括代码、JSON、引号、换行与反斜杠。`
    : `Change only ${from} to ${to}. Preserve every other character verbatim, including code, JSON, quotes, line breaks, and backslashes.`;
  return Object.freeze({ id, target, language, text, editing: 'rewrite', expected: text.replace(from, to), tags: Object.freeze(tags),
    rules: Object.freeze([Object.freeze({ id: 'authorized-edit', label: language === 'zh' ? '仅修改指定项' : 'Change only the specified item', kind: 'optimization', text: rule })]) });
}));
export const PROMPT_FAITHFUL_CASE = Object.freeze({ id: 'faithful-multi-cn', target: 'image', language: 'zh',
  text: '左边两只猫。右边一盏灯。不要增加人物。', editing: 'faithful', rules: Object.freeze([]) });
export const PROMPT_SUGGESTIONS_CASE = Object.freeze({ id: 'suggestions-en', target: 'general', language: 'en',
  text: 'Summarize the supplied document in three points. Preserve dates, names, and uncertainty. Do not invent missing facts.', editing: 'suggestions', rules: Object.freeze([]) });
export const PROMPT_LIVE_CASES = Object.freeze([...PROMPT_REWRITE_CASES, PROMPT_FAITHFUL_CASE, PROMPT_SUGGESTIONS_CASE]);
