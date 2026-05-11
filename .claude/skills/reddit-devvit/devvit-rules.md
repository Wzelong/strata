# Devvit Rules & App Review

## Table of Contents
- [App review process](#app-review-process)
- [General rules](#general-rules)
- [Safety rules](#safety-rules)
- [Privacy and data rules](#privacy-and-data-rules)
- [Content rules](#content-rules)
- [User action requirements](#user-action-requirements)
- [Deletion requirements](#deletion-requirements)
- [Brand and IP rules](#brand-and-ip-rules)
- [Payment rules](#payment-rules)
- [AI/LLM rules](#aillm-rules)
- [No linking out](#no-linking-out)

## App review process

- Apps need review to appear in the App Directory or unlock premium features (payments, fetch, LLMs)
- Playtest and local testing do NOT require review
- Review takes ~1 week, longer for complex apps or premium features
- Must resubmit for review on every publish (streamlined if no significant functionality changes)
- Review checks: code, description, functionality, compliance

Statuses: Approved, Approved with feedback, Rejected with feedback, Rejected (violation)

## General rules

- App must provide discrete functionality and make Reddit more enjoyable
- Use clear naming/descriptions that accurately describe functionality
- Include own terms of service + privacy policy if using premium features (payments, fetch, LLMs)
- Test locally and in sandbox subreddits before publishing
- Mod tools: provide clear configuration instructions in app description

## Safety rules

**Must:**
- Comply with Reddit Rules and Moderator Code of Conduct
- Label/warn before exposing graphic, explicit, or offensive content
- Build safeguards to prevent illegal/harmful content
- Provide users a way to report issues

**Must NOT:**
- Target anyone under 13
- Display mature content without age-gating
- Facilitate gambling, harassment, hate speech, violence, self-harm
- Manipulate voting/karma or circumvent safety mechanisms (blocking, bans)
- Include spam, malware, or deceptive functionality
- Promote regulated industries (gambling, healthcare, crypto, political, alcohol, drugs)

## Privacy and data rules

**Must:**
- Get explicit consent before processing data or taking actions on behalf of users
- Minimize data collection (only what's needed for stated functionality)
- Be transparent about data practices
- Keep app and data secure
- Notify Reddit and users if compromised (data breach)

**Must NOT:**
- Collect passwords or login credentials
- Profile redditors (race, politics, health, orientation, etc.)
- Surveil redditors or provide data to governments for surveillance
- Sell, license, or commercialize Reddit data (ads, data brokers, ML training)
- Transmit data of persons under 13
- Re-identify or de-anonymize data

**External services:**
- Required: own terms of service + privacy policy if using HTTP Fetch or collecting personal info
- You are responsible for verifying legitimacy/security of third-party sites

## Content rules

- All content must comply with Reddit Rules and Advertising Policy
- **Existing user content**: may copy/display/modify for display per Developer Terms
- **New user content**: must comply with User Agreement + Reddit Rules
- **Post/comment attribution**: clearly identify the content author
- **In-app content**: limit expression to prevent abuse (emojis, predefined dictionaries preferred over free-form text)
- **App content**: must not use external logos/trademarks without written permission

## User action requirements

When posting/commenting as user (`runAs: 'USER'`):
- Must be triggered by explicit manual action (button click)
- Make clear the user is posting as themselves
- Set `userGeneratedContent` correctly
- Score sharing comments: reply to sticky comment (not top-level unless user adds commentary)
- Do NOT automate these actions
- Do NOT require posting/commenting/subscribing for progress or access
- Keep gameplay separate from posting/subscribing actions

## Deletion requirements

**Post/Comment deletions (onPostDelete, onCommentDelete triggers):**
- Delete ALL content (title, body, URLs) from Redis and external services
- May retain metadata (IDs, timestamps) for context

**Account deletions:**
- Remove user ID (t2_*) from all datastores and external systems
- Remove all author-identifying info (name, profile URL, avatar, flair)
- May keep posts/comments if not explicitly deleted (but strip authorship)

**Best practice:** Use `redis.expire()` to auto-delete stored user data within 30 days.

**New user content:** Users must be able to remove their own content.

## Brand and IP rules

**Must NOT:**
- Use Reddit trademarks (REDDIT, SNOO) or brand assets without written permission
- Name app to suggest Reddit endorsement/partnership
- Use Snoo as a character without approval
- Infringe third-party IP (no clones/copycats)
- Create apps that impersonate other apps/developers/services

**Must:**
- Be original and innovative
- Have original name and branding

## Payment rules

- Must follow Reddit's Earn Terms and Earn Policy
- Cannot enable gambling or crypto exchange
- Cannot have deceptive pricing or limit core functionality behind paywall
- Cannot direct users off-platform for payment

## AI/LLM rules

**Approved LLMs only:**
- Google Gemini (`generativelanguage.googleapis.com`)
- OpenAI ChatGPT (`api.openai.com`)

**NOT approved:** Self-hosted LLMs (LLama, Mistral, Hugging Face, etc.)

**Requirements:**
- App must provide significant unique benefit to Reddit users
- Must NOT use Reddit data to train/fine-tune any AI models
- Must include terms of service and privacy policy
- Must adhere to all rate limits

## No linking out

Apps must NOT:
- Link to other apps or promote versions on external platforms
- Publish "demo" apps that link to full versions elsewhere
- Promote playing the same app on other platforms
- Ask users to create profiles outside Reddit

Reddit may reject/remove any app encouraging off-platform navigation.
