// COMMENTED/PENDING no retiran CHANGES_REQUESTED; tampoco acreditan por sí mismos una aprobación actual.
import type { Static } from "typebox";
import type { ReviewSchema } from "./lifecycle-github-schema.ts";
type GitHubReview = Static<typeof ReviewSchema>;
export function effectiveGitHubReviews(reviews: GitHubReview[], head: string) {
 const latest = new Map<string, GitHubReview>(), forHead = new Map<string, GitHubReview>();
 for (const review of reviews) {
  if (review.submitted_at !== null && !Number.isFinite(Date.parse(review.submitted_at))) return { valid: false, latest, forHead };
  if (!["APPROVED", "CHANGES_REQUESTED", "DISMISSED", "COMMENTED", "PENDING"].includes(review.state)) return { valid: false, latest, forHead };
  const login = review.user?.login.toLowerCase(); if (!login) continue;
  const previous = latest.get(login), current = forHead.get(login);
  if (!previous || review.id > previous.id) latest.set(login, review);
  if (!["COMMENTED", "PENDING"].includes(review.state) && review.commit_id === head && (!current || review.id > current.id)) forHead.set(login, review);
 }
 return { valid: true, latest, forHead };
}
