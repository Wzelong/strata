# Redis Reference

## Table of Contents
- [Setup](#setup)
- [String operations](#string-operations)
- [Batch operations](#batch-operations)
- [Hash operations](#hash-operations)
- [Sorted sets](#sorted-sets)
- [Number operations](#number-operations)
- [Key expiration](#key-expiration)
- [Transactions](#transactions)
- [Compression](#compression)
- [Limits](#limits)

## Setup

```json
// devvit.json
{ "permissions": { "redis": true } }
```

```typescript
import { redis } from '@devvit/web/server';
```

## String operations

```typescript
await redis.set('key', 'value');
const val = await redis.get('key');
await redis.del('key');
const exists = await redis.exists('key'); // number of keys that exist
const type = await redis.type('key');
await redis.rename('oldkey', 'newkey');
const sub = await redis.getRange('key', 0, 4);
await redis.setRange('key', 5, 'new');
const len = await redis.strLen('key');
```

## Batch operations

```typescript
await redis.mSet({ key1: 'val1', key2: 'val2' });
const values = await redis.mGet(['key1', 'key2']);
```

## Hash operations

```typescript
await redis.hSet('hash', { field1: 'val1', field2: 'val2' });
const val = await redis.hGet('hash', 'field1');
const all = await redis.hGetAll('hash');
const keys = await redis.hKeys('hash');
await redis.hDel('hash', ['field1']);
await redis.hSetNX('hash', 'field', 'value');
await redis.hIncrBy('hash', 'counter', 1);
const len = await redis.hLen('hash');

// Scanning
const { cursor, fieldValues } = await redis.hScan('hash', 0, undefined, 100);
```

## Sorted sets

```typescript
await redis.zAdd('leaderboard', { member: 'user1', score: 100 });
await redis.zAdd('leaderboard', { member: 'user2', score: 200 });

const card = await redis.zCard('leaderboard');
const score = await redis.zScore('leaderboard', 'user1');
const rank = await redis.zRank('leaderboard', 'user1');
await redis.zIncrBy('leaderboard', 'user1', 10);

// Range queries (LIMIT count capped to 1000 for score/lex)
const top = await redis.zRange('leaderboard', 0, 9, { reverse: true });
const byScore = await redis.zRange('leaderboard', 50, 200, { by: 'score' });

await redis.zRem('leaderboard', ['user1']);
await redis.zRemRangeByRank('leaderboard', 0, 4);
await redis.zRemRangeByScore('leaderboard', 0, 50);

// Scanning
const { cursor, members } = await redis.zScan('leaderboard', 0, undefined, 100);
```

## Number operations

```typescript
await redis.incrBy('counter', 1);
await redis.incrBy('counter', -5);
```

## Key expiration

```typescript
await redis.expire('key', 3600); // seconds
const remaining = await redis.expireTime('key');
```

## Transactions

```typescript
const txn = await redis.watch('key1', 'key2');
await txn.multi();
await txn.set('key1', 'newval');
await txn.incrBy('key2', 1);
const results = await txn.exec(); // returns array of results

// Discard
await txn.discard();
// Unwatch
await txn.unwatch();
```

Max 20 concurrent transactions per installation. 5s execution timeout.

## Compression

```typescript
import { redisCompressed as redis } from '@devvit/redis';
// Same API, auto-compresses on write, decompresses on read
// One-way: cannot switch back to standard client after writing compressed data
```

## Limits

| Limit | Value |
|-------|-------|
| Max commands/sec | 40,000 |
| Max request size | 5 MB |
| Max storage | 500 MB |
| Pipelining | Not supported |
| Sets | Only sorted sets |
| Key listing | Not supported |
| Lua scripts | Not supported |
| zRange LIMIT (score/lex) | 1000 per call |
| Concurrent transactions | 20 per install |

All limits are per-installation (per-subreddit).
