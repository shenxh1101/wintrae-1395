import { Router, Request, Response } from 'express'
import { prisma } from '../lib/prisma'

const router = Router()

router.get('/', async (_req: Request, res: Response) => {
  const stores = await prisma.store.findMany({
    where: { isActive: true },
    include: { _count: { select: { trainers: true } } },
    orderBy: { id: 'asc' },
  })
  res.json({ data: stores })
})

router.get('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  const store = await prisma.store.findUnique({
    where: { id },
    include: { trainers: { where: { isActive: true } } },
  })
  if (!store) return res.status(404).json({ error: '门店不存在' })
  res.json({ data: store })
})

export default router
