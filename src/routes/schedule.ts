import { Router, Request, Response } from 'express'
import { prisma } from '../lib/prisma'
import dayjs from 'dayjs'

const router = Router()

router.get('/available-slots', async (req: Request, res: Response) => {
  const storeId = Number(req.query.storeId)
  const date = req.query.date as string

  if (!storeId || !date) return res.status(400).json({ error: 'storeId 和 date 为必填' })

  const dayStart = dayjs(date).startOf('day').toDate()
  const dayEnd = dayjs(date).endOf('day').toDate()

  const slots = await prisma.schedule.findMany({
    where: { storeId, date: { gte: dayStart, lte: dayEnd }, isBooked: false },
    include: { trainer: true },
    orderBy: [{ startAt: 'asc' }],
  })

  const grouped = slots.reduce<Record<string, any[]>>((acc, s) => {
    const key = `${s.startAt}-${s.endAt}`
    if (!acc[key]) acc[key] = []
    acc[key].push({ scheduleId: s.id, trainer: { id: s.trainer.id, name: s.trainer.name, specialties: s.trainer.specialties } })
    return acc
  }, {})

  const result = Object.entries(grouped).map(([timeRange, trainers]) => {
    const [startAt, endAt] = timeRange.split('-')
    return { startAt, endAt, availableTrainers: trainers }
  })

  res.json({ data: result })
})

router.get('/trainer/:trainerId', async (req: Request, res: Response) => {
  const trainerId = Number(req.params.trainerId)
  const { startDate, endDate } = req.query as Record<string, string>

  const where: any = { trainerId, isBooked: true }
  if (startDate || endDate) {
    where.date = {}
    if (startDate) where.date.gte = dayjs(startDate).startOf('day').toDate()
    if (endDate) where.date.lte = dayjs(endDate).endOf('day').toDate()
  }

  const schedules = await prisma.schedule.findMany({
    where,
    include: { booking: { include: { member: true } } },
    orderBy: [{ date: 'asc' }, { startAt: 'asc' }],
  })

  res.json({ data: schedules })
})

router.post('/', async (req: Request, res: Response) => {
  const { trainerId, storeId, date, startAt, endAt } = req.body
  if (!trainerId || !storeId || !date || !startAt || !endAt)
    return res.status(400).json({ error: '缺少必填字段' })

  const schedule = await prisma.schedule.create({
    data: { trainerId, storeId, date: new Date(date), startAt, endAt },
  })
  res.status(201).json({ data: schedule })
})

router.post('/batch', async (req: Request, res: Response) => {
  const { trainerId, storeId, date, slots } = req.body
  if (!trainerId || !storeId || !date || !Array.isArray(slots))
    return res.status(400).json({ error: '缺少必填字段' })

  const data = slots.map((s: { startAt: string; endAt: string }) => ({
    trainerId,
    storeId,
    date: new Date(date),
    startAt: s.startAt,
    endAt: s.endAt,
  }))

  const result = await prisma.schedule.createMany({ data })
  res.status(201).json({ created: result.count })
})

router.delete('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  const schedule = await prisma.schedule.findUnique({ where: { id } })
  if (!schedule) return res.status(404).json({ error: '排班不存在' })
  if (schedule.isBooked) return res.status(400).json({ error: '已被预约的时段不可删除' })

  await prisma.schedule.delete({ where: { id } })
  res.json({ message: '排班已删除' })
})

export default router
