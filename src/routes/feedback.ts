import { Router, Request, Response } from 'express'
import { prisma } from '../lib/prisma'

const router = Router()

router.post('/', async (req: Request, res: Response) => {
  const { bookingId, rating, content } = req.body
  if (!bookingId || rating === undefined)
    return res.status(400).json({ error: 'bookingId 和 rating 为必填' })
  if (rating < 1 || rating > 5) return res.status(400).json({ error: '评分范围 1-5' })

  const booking = await prisma.booking.findUnique({ where: { id: bookingId } })
  if (!booking) return res.status(404).json({ error: '预约不存在' })
  if (booking.status !== 'completed' && booking.status !== 'checked_in')
    return res.status(400).json({ error: '仅已签到/已完成的课程可评价' })

  const existing = await prisma.feedback.findUnique({ where: { bookingId } })
  if (existing) return res.status(409).json({ error: '该课程已有反馈' })

  const feedback = await prisma.feedback.create({
    data: { bookingId, trainerId: booking.trainerId, memberId: booking.memberId, rating, content: content || null },
    include: { trainer: true, member: true },
  })

  res.status(201).json({ data: feedback })
})

router.get('/booking/:bookingId', async (req: Request, res: Response) => {
  const bookingId = Number(req.params.bookingId)
  const feedback = await prisma.feedback.findUnique({
    where: { bookingId },
    include: { trainer: true, member: true },
  })
  if (!feedback) return res.status(404).json({ error: '反馈不存在' })
  res.json({ data: feedback })
})

router.get('/trainer/:trainerId', async (req: Request, res: Response) => {
  const trainerId = Number(req.params.trainerId)
  const feedbacks = await prisma.feedback.findMany({
    where: { trainerId },
    include: { member: true },
    orderBy: { createdAt: 'desc' },
  })
  const avgRating = feedbacks.length
    ? feedbacks.reduce((sum, f) => sum + f.rating, 0) / feedbacks.length
    : 0
  res.json({ data: { avgRating: Math.round(avgRating * 10) / 10, total: feedbacks.length, feedbacks } })
})

export default router
