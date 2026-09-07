// Missing measurements stay missing; an observed zero remains a valid result.
export function num(value) {
  if (value == null || String(value).trim() === '') return null;
  const text = String(value).replaceAll(',', '').trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  return Number(text);
}

export function collapse(records) {
  const grouped = new Map();
  for (const r of records) {
    const row = {
      account: r.account_handle,
      title: (r.instagram_card_title || r.instagram_reel_title || r.content_title_hint || '').trim(),
      code: r.instagram_shortcode || null,
      date: r.instagram_post_date || null,
      snapshot: r.snapshot_date || '',
      views: num(r.summary?.views), reach: num(r.summary?.reach_or_viewers),
      follows: num(r.summary?.follows), watch: num(r.summary?.average_watch_time?.value),
      saves: num(r.header_counters_display?.saves), shares: num(r.header_counters_display?.shares),
    };
    if (row.views == null || row.views <= 0 || row.follows == null) continue;
    const key = row.account + '|' + (row.code || r.record_id);
    const prev = grouped.get(key);
    if (!prev || row.snapshot > prev.snapshot || (row.snapshot === prev.snapshot && row.follows > prev.follows)) grouped.set(key, row);
  }
  return [...grouped.values()];
}
