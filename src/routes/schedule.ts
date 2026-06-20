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
    include: { bookings: { where: { status: { in: ['booked', 'checked_in', 'completed'] } }, include: { member: true } } },
    orderBy: [{ date: 'asc' }, { startAt: 'asc' }],
  })

  const result = schedules.map(s => ({
    ...s,
    booking: s.bookings[0] || null,
  }))

  res.json({ data: result })
})

router.get('/trainer/:trainerId/daily', async (req: Request, res: Response) => {
  const trainerId = Number(req.params.trainerId)
  const date = req.query.date as string
  const targetDate = date ? dayjs(date) : dayjs()
  const dayStart = targetDate.startOf('day').toDate()
  const dayEnd = targetDate.endOf('day').toDate()

  const trainer = await prisma.trainer.findUnique({ where: { id: trainerId } })
  if (!trainer) return res.status(404).json({ error: '教练不存在' })

  const bookings = await prisma.booking.findMany({
    where: {
      trainerId,
      schedule: { date: { gte: dayStart, lte: dayEnd } },
    },
    include: {
      member: true,
      store: true,
      schedule: true,
      feedback: true,
    },
    orderBy: [{ schedule: { startAt: 'asc' } }],
  })

  const grouped: Record<string, any[]> = {
    booked: [],
    checked_in: [],
    completed: [],
    no_show: [],
    cancelled: [],
  }
  for (const b of bookings) {
    grouped[b.status]?.push({
      bookingId: b.id,
      memberId: b.memberId,
      memberName: b.member.name,
      memberPhone: b.member.phone,
      date: b.schedule.date,
      startAt: b.schedule.startAt,
      endAt: b.schedule.endAt,
      storeName: b.store.name,
      status: b.status,
      checkedInAt: b.checkedInAt,
      hasFeedback: !!b.feedback,
      feedbackRating: b.feedback?.rating,
      feedbackContent: b.feedback?.content,
    })
  }

  const total = bookings.length
  const completed = grouped.completed.length + grouped.checked_in.length

  res.json({
    data: {
      date: targetDate.format('YYYY-MM-DD'),
      trainer: { id: trainer.id, name: trainer.name, specialties: trainer.specialties },
      summary: {
        totalCount: total,
        bookedCount: grouped.booked.length,
        checkedInCount: grouped.checked_in.length,
        completedCount: grouped.completed.length,
        noShowCount: grouped.no_show.length,
        cancelledCount: grouped.cancelled.length,
        attendanceRate: total > 0 ? Math.round(((completed) / total) * 100) : 0,
      },
      groupedBookings: grouped,
    },
  })
})

router.get('/trainer/:trainerId/weekly', async (req: Request, res: Response) => {
  const trainerId = Number(req.params.trainerId)
  const { weekStart } = req.query as Record<string, string>

  const baseDate = weekStart ? dayjs(weekStart) : dayjs()
  const start = baseDate.startOf('week')
  const end = baseDate.endOf('week')

  const trainer = await prisma.trainer.findUnique({ where: { id: trainerId } })
  if (!trainer) return res.status(404).json({ error: '教练不存在' })

  const bookings = await prisma.booking.findMany({
    where: {
      trainerId,
      schedule: { date: { gte: start.toDate(), lte: end.toDate() } },
    },
    include: { member: true, store: true, schedule: true, feedback: true },
    orderBy: [{ schedule: { date: 'asc' } }, { schedule: { startAt: 'asc' } }],
  })

  const days: Record<string, any> = {}
  for (let i = 0; i < 7; i++) {
    const d = start.add(i, 'day')
    const key = d.format('YYYY-MM-DD')
    days[key] = {
      date: key,
      dayOfWeek: d.day(),
      bookings: [],
      stats: { total: 0, booked: 0, checked_in: 0, completed: 0, no_show: 0, cancelled: 0 },
    }
  }

  for (const b of bookings) {
    const dateKey = dayjs(b.schedule.date).format('YYYY-MM-DD')
    if (!days[dateKey]) continue
    days[dateKey].bookings.push({
      bookingId: b.id,
      memberId: b.memberId,
      memberName: b.member.name,
      startAt: b.schedule.startAt,
      endAt: b.schedule.endAt,
      status: b.status,
      storeName: b.store.name,
      hasFeedback: !!b.feedback,
    })
    days[dateKey].stats.total++
    if (days[dateKey].stats[b.status] !== undefined) {
      days[dateKey].stats[b.status]++
    }
  }

  const totalBookings = bookings.length
  const completedCount = bookings.filter(b => b.status === 'completed').length
  const checkedInCount = bookings.filter(b => b.status === 'checked_in').length
  const cancelledCount = bookings.filter(b => b.status === 'cancelled').length
  const noShowCount = bookings.filter(b => b.status === 'no_show').length

  const feedbacks = bookings.filter(b => b.feedback)
  const avgRating = feedbacks.length
    ? feedbacks.reduce((s, b) => s + (b.feedback?.rating || 0), 0) / feedbacks.length
    : 0

  const todayKey = dayjs().format('YYYY-MM-DD')
  const todayBookings = days[todayKey]?.bookings || []
  const pendingToday = todayBookings.filter((b: any) => b.status === 'booked')

  res.json({
    data: {
      weekStart: start.format('YYYY-MM-DD'),
      weekEnd: end.format('YYYY-MM-DD'),
      trainer: { id: trainer.id, name: trainer.name, specialties: trainer.specialties },
      summary: {
        totalBookings,
        completedCount,
        checkedInCount,
        cancelledCount,
        noShowCount,
        attendanceRate: totalBookings > 0
          ? Math.round(((completedCount + checkedInCount + bookings.filter(b => b.status === 'booked').length) / totalBookings) * 100)
          : 0,
        completionRate: totalBookings > 0 ? Math.round((completedCount / totalBookings) * 100) : 0,
        feedbackCount: feedbacks.length,
        avgRating: Math.round(avgRating * 10) / 10,
        pendingTodayCount: pendingToday.length,
      },
      daily: Object.values(days),
    },
  })
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
