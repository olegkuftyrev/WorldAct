/** Source-like post_date for existing records. A rescheduled publication uses
 * its current schedule; other records keep their chosen publication or creation
 * date. Trusted SQL expression for routes whose posts alias is p. */
export const POST_DATE_SQL = "COALESCE(CASE WHEN p.status='future' THEN p.scheduled_at END,p.published_at,p.created_at)";
