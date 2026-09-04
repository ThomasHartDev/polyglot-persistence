export const CONSTRAINTS = [
  'CREATE CONSTRAINT user_id IF NOT EXISTS FOR (u:User) REQUIRE u.id IS UNIQUE',
  'CREATE CONSTRAINT user_handle IF NOT EXISTS FOR (u:User) REQUIRE u.handle IS UNIQUE',
  'CREATE CONSTRAINT post_id IF NOT EXISTS FOR (p:Post) REQUIRE p.id IS UNIQUE',
] as const

const USER = 'u.id AS id, u.handle AS handle, u.createdAt AS createdAt'
const POST = 'p.id AS id, a.id AS authorId, p.body AS body, p.createdAt AS createdAt'
const NEWEST = 'ORDER BY p.createdAt DESC, p.id DESC LIMIT $limit'
const BEFORE =
  'WHERE p.createdAt < $createdAt OR (p.createdAt = $createdAt AND p.id < $postId)'

export const CYPHER = {
  createUser: `CREATE (u:User {id: $id, handle: $handle, createdAt: $createdAt}) RETURN ${USER}`,
  getUser: `MATCH (u:User {id: $id}) RETURN ${USER}`,
  getUserByHandle: `MATCH (u:User {handle: $handle}) RETURN ${USER}`,
  follow: `MATCH (a:User {id: $from}), (b:User {id: $to}) WHERE a <> b MERGE (a)-[:FOLLOWS]->(b)`,
  unfollow: `MATCH (a:User {id: $from})-[r:FOLLOWS]->(b:User {id: $to}) DELETE r`,
  isFollowing: `MATCH (a:User {id: $from})-[r:FOLLOWS]->(b:User {id: $to}) RETURN count(r) AS n`,
  following: `MATCH (a:User {id: $id})-[:FOLLOWS]->(b:User) RETURN b.id AS id ORDER BY b.id`,
  followers: `MATCH (a:User {id: $id})<-[:FOLLOWS]-(b:User) RETURN b.id AS id ORDER BY b.id`,
  publish: `MATCH (a:User {id: $authorId}) CREATE (p:Post {id: $id, body: $body, createdAt: $createdAt}) CREATE (a)-[:AUTHORED]->(p) RETURN ${POST}`,
  getPost: `MATCH (a:User)-[:AUTHORED]->(p:Post {id: $id}) RETURN ${POST}`,
  authorTimeline: `MATCH (a:User {id: $authorId})-[:AUTHORED]->(p:Post) RETURN ${POST} ${NEWEST}`,
  authorTimelineBefore: `MATCH (a:User {id: $authorId})-[:AUTHORED]->(p:Post) ${BEFORE} RETURN ${POST} ${NEWEST}`,
  feed: `MATCH (u:User {id: $userId})-[:FOLLOWS]->(a:User)-[:AUTHORED]->(p:Post) RETURN ${POST} ${NEWEST}`,
  feedBefore: `MATCH (u:User {id: $userId})-[:FOLLOWS]->(a:User)-[:AUTHORED]->(p:Post) ${BEFORE} RETURN ${POST} ${NEWEST}`,
  shortestPath: `MATCH (a:User {id: $from}), (b:User {id: $to}) MATCH path = shortestPath((a)-[:FOLLOWS*..16]->(b)) RETURN [n IN nodes(path) | n.id] AS ids`,
  recommend: `MATCH (u:User {id: $id})-[:FOLLOWS]->()-[:FOLLOWS]->(rec:User) WHERE rec.id <> $id AND NOT (u)-[:FOLLOWS]->(rec) RETURN rec.id AS id, count(*) AS score ORDER BY score DESC, rec.id LIMIT $limit`,
  isMutual: `MATCH (a:User {id: $a})-[:FOLLOWS]->(b:User {id: $b})-[:FOLLOWS]->(a) RETURN count(*) > 0 AS mutual`,
  commonFollowees: `MATCH (a:User {id: $a})-[:FOLLOWS]->(x:User)<-[:FOLLOWS]-(b:User {id: $b}) RETURN x.id AS id ORDER BY x.id`,
} as const
