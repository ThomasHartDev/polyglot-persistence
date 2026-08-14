import { BODY_MAX, StoreError, type ActivityStore } from '../src/index'

export function defineStoreContract(
  name: string,
  create: () => ActivityStore | Promise<ActivityStore>,
): void {
  describe(`${name} activity-store contract`, () => {
    async function fresh(): Promise<ActivityStore> {
      return await create()
    }

    it('creates a user and looks them up by id and handle', async () => {
      const s = await fresh()
      const user = await s.createUser({ id: 'u1', handle: '  Ada  ' }, 10)
      expect(user).toEqual({ id: 'u1', handle: 'ada', createdAt: 10 })
      expect(await s.getUser('u1')).toEqual(user)
      expect(await s.getUserByHandle('ADA')).toEqual(user)
      expect(await s.getUser('missing')).toBeNull()
      expect(await s.getUser(' not an id ')).toBeNull()
      expect(await s.getUserByHandle('???')).toBeNull()
    })

    it('rejects a duplicate user id and a duplicate handle', async () => {
      const s = await fresh()
      await s.createUser({ id: 'u1', handle: 'ada' })
      await expect(s.createUser({ id: 'u1', handle: 'ada2' })).rejects.toMatchObject({
        code: 'user_exists',
      })
      await expect(s.createUser({ id: 'u2', handle: 'ADA' })).rejects.toMatchObject({
        code: 'handle_taken',
      })
      await expect(s.createUser({ id: 'u1', handle: 'ada2' })).rejects.toBeInstanceOf(
        StoreError,
      )
    })

    it('rejects malformed ids and handles on create', async () => {
      const s = await fresh()
      await expect(s.createUser({ id: '', handle: 'ada' })).rejects.toMatchObject({
        code: 'invalid_id',
      })
      await expect(s.createUser({ id: 'u1', handle: '1ada' })).rejects.toMatchObject({
        code: 'invalid_handle',
      })
      await expect(s.createUser({ id: 'u1', handle: 'has-dash' })).rejects.toMatchObject({
        code: 'invalid_handle',
      })
    })

    it('follows idempotently and lists both directions in sorted order', async () => {
      const s = await fresh()
      await seed(s, ['ada', 'bob', 'cam'])
      await s.follow('ada', 'bob')
      await s.follow('ada', 'bob')
      await s.follow('ada', 'cam')
      await s.follow('bob', 'cam')
      expect(await s.isFollowing('ada', 'bob')).toBe(true)
      expect(await s.isFollowing('bob', 'ada')).toBe(false)
      expect(await s.following('ada')).toEqual(['bob', 'cam'])
      expect(await s.followers('cam')).toEqual(['ada', 'bob'])
    })

    it('rejects self-follow and follows involving a missing user', async () => {
      const s = await fresh()
      await seed(s, ['ada'])
      await expect(s.follow('ada', 'ada')).rejects.toMatchObject({ code: 'self_follow' })
      await expect(s.follow('ada', 'ghost')).rejects.toMatchObject({
        code: 'user_not_found',
      })
      await expect(s.following('ghost')).rejects.toMatchObject({ code: 'user_not_found' })
    })

    it('unfollows an edge and no-ops when the edge is already gone', async () => {
      const s = await fresh()
      await seed(s, ['ada', 'bob'])
      await s.follow('ada', 'bob')
      await s.unfollow('ada', 'bob')
      await s.unfollow('ada', 'bob')
      expect(await s.isFollowing('ada', 'bob')).toBe(false)
      expect(await s.following('ada')).toEqual([])
      expect(await s.followers('bob')).toEqual([])
    })

    it('publishes newest-first per author and rejects bad posts', async () => {
      const s = await fresh()
      await seed(s, ['ada'])
      const older = await s.publish({ id: 'p1', authorId: 'ada', body: 'one' }, 1)
      const newer = await s.publish({ id: 'p2', authorId: 'ada', body: 'two' }, 5)
      expect(await s.getPost('p2')).toEqual(newer)
      expect(await s.postsByAuthor('ada')).toEqual([newer, older])
      await expect(
        s.publish({ id: 'p3', authorId: 'ghost', body: 'x' }),
      ).rejects.toMatchObject({ code: 'user_not_found' })
      await expect(
        s.publish({ id: 'p3', authorId: 'ada', body: '   ' }),
      ).rejects.toMatchObject({ code: 'invalid_body' })
      await expect(
        s.publish({ id: 'p3', authorId: 'ada', body: 'x'.repeat(BODY_MAX + 1) }),
      ).rejects.toMatchObject({ code: 'invalid_body' })
      await expect(
        s.publish({ id: 'p1', authorId: 'ada', body: 'dup' }),
      ).rejects.toMatchObject({ code: 'post_exists' })
    })

    it('builds a live feed from followees only, newest first', async () => {
      const s = await fresh()
      await seed(s, ['ada', 'bob', 'cam'])
      await s.follow('ada', 'bob')
      const b1 = await s.publish({ id: 'b1', authorId: 'bob', body: 'b1' }, 1)
      await s.publish({ id: 'c1', authorId: 'cam', body: 'c1' }, 9)
      const b2 = await s.publish({ id: 'b2', authorId: 'bob', body: 'b2' }, 5)
      await s.publish({ id: 'a1', authorId: 'ada', body: 'own' }, 20)
      expect(await s.feed('ada')).toEqual([b2, b1])
      expect(await s.feed('cam')).toEqual([])
    })

    it('pages the feed with a compound cursor across equal timestamps', async () => {
      const s = await fresh()
      await seed(s, ['ada', 'bob', 'cam'])
      await s.follow('ada', 'bob')
      await s.follow('ada', 'cam')
      const p1 = await s.publish({ id: 'p1', authorId: 'bob', body: 'p1' }, 10)
      const p2 = await s.publish({ id: 'p2', authorId: 'cam', body: 'p2' }, 10)
      const p3 = await s.publish({ id: 'p3', authorId: 'bob', body: 'p3' }, 4)
      expect(await s.feed('ada', { limit: 1 })).toEqual([p2])
      expect(await s.feed('ada', { limit: 1, before: p2 })).toEqual([p1])
      expect(await s.feed('ada', { limit: 2, before: p1 })).toEqual([p3])
      expect(await s.feed('ada', { limit: 0 })).toHaveLength(3)
      expect(await s.feed('ada', { limit: 999 })).toHaveLength(3)
    })

    it('drops an author from the live feed after unfollow', async () => {
      const s = await fresh()
      await seed(s, ['ada', 'bob'])
      await s.follow('ada', 'bob')
      await s.publish({ id: 'b1', authorId: 'bob', body: 'hi' }, 1)
      await s.unfollow('ada', 'bob')
      expect(await s.feed('ada')).toEqual([])
      expect(await s.postsByAuthor('bob')).toHaveLength(1)
    })
  })
}

async function seed(store: ActivityStore, ids: string[]): Promise<void> {
  for (const id of ids) {
    await store.createUser({ id, handle: id }, 1)
  }
}
