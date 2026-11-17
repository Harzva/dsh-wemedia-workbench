export const WECHAT_READBACK_CHECKS = [
  "present", "title_matches", "topic_prefix_present", "digest_matches", "digest_plain_text",
  "content_text_matches", "result_table_count_matches", "result_table_cells_match", "content_deep",
  "image_count_matches", "images_uploaded", "images_match_approved_uploads", "image_upload_map_count_matches",
  "source_url_matches", "official_page_url_visible", "official_pdf_url_visible", "code_url_visible_or_not_required",
  "cover_present", "developer_notes_absent", "local_paths_absent",
] as const;

export type WechatReadbackCheck = (typeof WECHAT_READBACK_CHECKS)[number];
