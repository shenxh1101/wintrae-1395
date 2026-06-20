import { Router, Request, Response } from 'express'
import { prisma } from '../lib/prisma'

const router = Router()

router.get('/member/:memberId', async (req: Request, res: Response) => {
  const memberId = Number(req.params.memberId)
  const { type, isRead } = req.query as Record<string, string>

  const where: any = { memberId }
  if (type) where.type = type
  if (isRead !== undefined) where.isRead = isRead === 'true'

  const notifications = await prisma.notification.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  })
  res.json({ data: notifications })
})

router.put('/:id/read', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  try {
    const notification = await prisma.notification.update({
      where: { id },
      data: { isRead: true },
    })
    res.json({ data: notification })
  } catch {
    res.status(404).json({ error: '通知不存在' })
  }
})

router.put('/member/:memberId/read-all', async (req: Request, res: Response) => {
  const memberId = Number(req.params.memberId)
  await prisma.notification.updateMany({
    where: { memberId, isRead: false },
    data: { isRead: true },
  })
  res.json({ message: '已全部标为已读' })
})

router.get('/member/:memberId/unread-count', async (req: Request, res: Response) => {
  const memberId = Number(req.params.memberId)
  const count = await prisma.notification.count({
    where: { memberId, isRead: false },
  })
  res.json({ data: { unreadCount: count } })
})

export default router
