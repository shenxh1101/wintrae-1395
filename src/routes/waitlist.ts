import { Router, Request, Response } from 'express'
import { prisma } from '../lib/prisma'
import dayjs from 'dayjs'
import { promoteNextWaitlist, CONFIRM_WINDOW_MINUTES } from '../lib/waitlist'

const router = Router()

router.post('/', async (req: Request, res: Response) => {
  const { memberId, scheduleId, memberPackageId } = req.body
  if (!memberId || !scheduleId || !memberPackageId)
    return res.status(400).json({ error: 'memberId、scheduleId、memberPackageId 为必填' })

  const schedule = await prisma.schedule.findUnique({
    where: { id: Number(scheduleId) },
    include: { trainer: true, store: true },
  })
  if (!schedule) return res.status(404).json({ error: '排班时段不存在' })

  const now = new Date()
  if (dayjs(schedule.date).hour(Number(schedule.startAt.split(':')[0])).isBefore(now))
    return res.status(400).json({ error: '该时段已过，不可候补' })

  const activeBooking = await prisma.booking.findFirst({
    where: { scheduleId: Number(scheduleId), status: { in: ['booked', 'checked_in'] } },
  })
  const pendingConfirm = await prisma.waitlist.findFirst({
    where: { scheduleId: Number(scheduleId), status: 'pending_confirm' },
  })
  if (!activeBooking && !pendingConfirm)
    return res.status(400).json({ error: '该时段尚未约满，可直接预约无需候补' })

  const mp = await prisma.memberPackage.findUnique({ where: { id: Number(memberPackageId) } })
  if (!mp) return res.status(404).json({ error: '课程包不存在' })
  if (mp.memberId !== Number(memberId)) return res.status(400).json({ error: '课程包不属于该会员' })
  if (mp.remainSlots <= 0) return res.status(400).json({ error: '课时余量不足，无法加入候补' })
  if (mp.expireAt && mp.expireAt < schedule.date) return res.status(400).json({ error: '课程包在该时段前已过期' })

  const existingBooking = await prisma.booking.findFirst({
    where: {
      memberId: Number(memberId),
      status: { in: ['booked', 'checked_in'] },
      schedule: { date: schedule.date, startAt: schedule.startAt },
    },
  })
  if (existingBooking) return res.status(409).json({ error: '您在该时段已有预约' })

  const existingWaitlist = await prisma.waitlist.findFirst({
    where: { memberId: Number(memberId), scheduleId: Number(scheduleId), status: { in: ['waiting', 'pending_confirm'] } },
  })
  if (existingWaitlist) return res.status(409).json({ error: '您已在该时段的候补队列中' })

  const waitCount = await prisma.waitlist.count({ where: { scheduleId: Number(scheduleId), status: 'waiting' } })
  const waitlist = await prisma.waitlist.create({
    data: {
      memberId: Number(memberId),
      scheduleId: Number(scheduleId),
      memberPackageId: Number(memberPackageId),
      priority: waitCount + 1,
      status: 'waiting',
    },
    include: { member: true, schedule: { include: { trainer: true } } },
  })

  res.status(201).json({
    data: {
      id: waitlist.id,
      memberId: waitlist.memberId,
      scheduleId: waitlist.scheduleId,
      position: waitCount + 1,
      status: waitlist.status,
      trainerName: schedule.trainer.name,
      date: schedule.date,
      startAt: schedule.startAt,
      endAt: schedule.endAt,
    },
  })
})

router.post('/:id/confirm', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  const waitlist = await prisma.waitlist.findUnique({
    where: { id },
    include: { schedule: { include: { trainer: true, store: true } }, memberPackage: true },
  })
  if (!waitlist) return res.status(404).json({ error: '候补记录不存在' })

  if (waitlist.status === 'promoted') return res.status(400).json({ error: '该候补已完成补位' })
  if (waitlist.status === 'expired') return res.status(400).json({ error: '确认超时，候补名额已失效' })
  if (waitlist.status === 'rejected') return res.status(400).json({ error: '该候补已放弃' })
  if (waitlist.status === 'cancelled') return res.status(400).json({ error: '该候补已取消' })
  if (waitlist.status === 'waiting') return res.status(400).json({ error: '尚未轮到您，请等待补位通知' })
  if (waitlist.status !== 'pending_confirm') return res.status(400).json({ error: `当前状态(${waitlist.status})不可确认` })

  const now = new Date()
  if (waitlist.confirmExpireAt && waitlist.confirmExpireAt < now) {
    await prisma.waitlist.update({ where: { id }, data: { status: 'expired', confirmExpireAt: null } })
    const promoted = await promoteNextWaitlist(waitlist.scheduleId)
    return res.status(410).json({
      error: '确认已超时，请重新候补',
      promotedNext: !!promoted,
      nextMemberId: promoted?.memberId ?? null,
    })
  }

  const mp = waitlist.memberPackage
  const schedule = waitlist.schedule
  const validationErrors: string[] = []

  if (mp.remainSlots <= 0) validationErrors.push('课程包课时已用完')
  if (mp.expireAt && mp.expireAt < now) validationErrors.push('课程包已过期')
  if (mp.expireAt && mp.expireAt < schedule.date) validationErrors.push('课程包在课程日期前已过期')

  const conflict = await prisma.booking.findFirst({
    where: {
      memberId: waitlist.memberId,
      status: { in: ['booked', 'checked_in'] },
      schedule: { date: schedule.date, startAt: schedule.startAt },
    },
  })
  if (conflict) validationErrors.push('您在同一时段已有有效预约')

  if (validationErrors.length > 0) {
    await prisma.waitlist.update({ where: { id }, data: { status: 'invalid', confirmExpireAt: null } })
    const promoted = await promoteNextWaitlist(waitlist.scheduleId)
    return res.status(409).json({
      error: validationErrors.join('；'),
      promotedNext: !!promoted,
      nextMemberId: promoted?.memberId ?? null,
    })
  }

  const existingBookingSameSlot = await prisma.booking.findFirst({
    where: { scheduleId: schedule.id, status: { in: ['booked', 'checked_in'] } },
  })
  if (existingBookingSameSlot) {
    await prisma.waitlist.update({ where: { id }, data: { status: 'waiting', confirmExpireAt: null, priority: (await prisma.waitlist.count({ where: { scheduleId: schedule.id, status: 'waiting' } })) + 1 } })
    return res.status(409).json({ error: '名额已被占用，已退回等待队列' })
  }

  const result = await prisma.$transaction(async (tx) => {
    const freshMp = await tx.memberPackage.findUnique({ where: { id: mp.id } })
    if (!freshMp || freshMp.remainSlots <= 0) throw new Error('课时余量不足，已被其他操作占用')

    const updatedMp = await tx.memberPackage.update({
      where: { id: mp.id },
      data: { remainSlots: { decrement: 1 } },
    })
    if (updatedMp.remainSlots < 0) throw new Error('课时余量不足，扣减失败')

    await tx.schedule.update({ where: { id: schedule.id }, data: { isBooked: true } })
    const booking = await tx.booking.create({
      data: {
        memberId: waitlist.memberId,
        trainerId: schedule.trainerId,
        storeId: schedule.storeId,
        scheduleId: schedule.id,
        memberPackageId: mp.id,
        status: 'booked',
      },
      include: { member: true, trainer: true, schedule: true, store: true },
    })
    await tx.waitlist.update({ where: { id }, data: { status: 'promoted', confirmExpireAt: null } })
    await tx.notification.create({
      data: {
        memberId: waitlist.memberId,
        type: 'booking_confirmed',
        title: '候补确认成功',
        content: `您已确认候补 ${dayjs(schedule.date).format('MM-DD')} ${schedule.startAt}-${schedule.endAt} ${schedule.trainer.name} 教练的课程，请按时到店`,
      },
    })
    return booking
  })

  res.json({
    data: {
      booking: {
        id: result.id,
        memberId: result.memberId,
        trainerId: result.trainerId,
        storeId: result.storeId,
        scheduleId: result.scheduleId,
        status: result.status,
        date: result.schedule.date,
        startAt: result.schedule.startAt,
        endAt: result.schedule.endAt,
        trainerName: result.trainer.name,
        storeName: result.store.name,
      },
      waitlistId: id,
      remainSlots: (await prisma.memberPackage.findUnique({ where: { id: mp.id } }))?.remainSlots ?? 0,
    },
  })
})

router.post('/:id/reject', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  const waitlist = await prisma.waitlist.findUnique({
    where: { id },
    include: { schedule: { include: { trainer: true } } },
  })
  if (!waitlist) return res.status(404).json({ error: '候补记录不存在' })
  if (waitlist.status !== 'pending_confirm')
    return res.status(400).json({ error: `仅待确认状态可拒绝，当前为${waitlist.status}` })

  await prisma.waitlist.update({ where: { id }, data: { status: 'rejected', confirmExpireAt: null } })

  await prisma.notification.create({
    data: {
      memberId: waitlist.memberId,
      type: 'waitlist_rejected',
      title: '候补名额已放弃',
      content: `您已放弃 ${dayjs(waitlist.schedule.date).format('MM-DD')} ${waitlist.schedule.startAt} 的候补名额`,
    },
  })

  const promoted = await promoteNextWaitlist(waitlist.scheduleId)

  res.json({
    data: {
      success: true,
      message: '已放弃候补名额',
      promotedNext: !!promoted,
      nextMemberId: promoted?.memberId ?? null,
      scheduleNowAvailable: !promoted,
    },
  })
})

router.delete('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  const waitlist = await prisma.waitlist.findUnique({ where: { id } })
  if (!waitlist) return res.status(404).json({ error: '候补记录不存在' })
  if (waitlist.status !== 'waiting') return res.status(400).json({ error: '仅等待中候补可取消' })

  await prisma.waitlist.update({ where: { id }, data: { status: 'cancelled' } })

  const remaining = await prisma.waitlist.findMany({
    where: { scheduleId: waitlist.scheduleId, status: 'waiting', priority: { gt: waitlist.priority } },
    orderBy: { priority: 'asc' },
  })
  for (const w of remaining) {
    await prisma.waitlist.update({ where: { id: w.id }, data: { priority: { decrement: 1 } } })
  }

  res.json({ message: '已取消候补' })
})

router.get('/schedule/:scheduleId', async (req: Request, res: Response) => {
  const scheduleId = Number(req.params.scheduleId)

  const schedule = await prisma.schedule.findUnique({
    where: { id: scheduleId },
    include: { trainer: true, store: true, bookings: { where: { status: { in: ['booked', 'checked_in'] } }, take: 1 } },
  })
  if (!schedule) return res.status(404).json({ error: '时段不存在' })

  const hasActiveBooking = schedule.bookings.length > 0
  const waitlist = await prisma.waitlist.findMany({
    where: { scheduleId, status: { in: ['waiting', 'pending_confirm'] } },
    include: { member: true },
    orderBy: [{ status: 'desc' }, { priority: 'asc' }],
  })

  const pendingConfirm = waitlist.find(w => w.status === 'pending_confirm')
  const waiting = waitlist.filter(w => w.status === 'waiting')

  res.json({
    data: {
      scheduleId,
      date: schedule.date,
      startAt: schedule.startAt,
      endAt: schedule.endAt,
      trainerName: schedule.trainer.name,
      storeName: schedule.store.name,
      hasActiveBooking,
      currentTurn: pendingConfirm ? {
        type: 'pending_confirm',
        waitlistId: pendingConfirm.id,
        memberId: pendingConfirm.memberId,
        memberName: pendingConfirm.member.name,
        memberPhone: pendingConfirm.member.phone,
        confirmExpireAt: pendingConfirm.confirmExpireAt,
        remainMinutes: pendingConfirm.confirmExpireAt
          ? Math.max(0, Math.ceil((pendingConfirm.confirmExpireAt.getTime() - Date.now()) / 60000))
          : 0,
      } : waiting.length > 0 ? {
        type: 'waiting_top',
        waitlistId: waiting[0].id,
        memberId: waiting[0].memberId,
        memberName: waiting[0].member.name,
        memberPhone: waiting[0].member.phone,
      } : hasActiveBooking ? {
        type: 'booked_no_waitlist',
      } : {
        type: 'available',
      },
      pendingConfirm: pendingConfirm ? {
        id: pendingConfirm.id,
        memberId: pendingConfirm.memberId,
        memberName: pendingConfirm.member.name,
        memberPhone: pendingConfirm.member.phone,
        confirmExpireAt: pendingConfirm.confirmExpireAt,
        remainMinutes: pendingConfirm.confirmExpireAt
          ? Math.max(0, Math.ceil((pendingConfirm.confirmExpireAt.getTime() - Date.now()) / 60000))
          : 0,
        joinedAt: pendingConfirm.createdAt,
      } : null,
      waiting: waiting.map((w, i) => ({
        id: w.id,
        position: i + 1,
        memberId: w.memberId,
        memberName: w.member.name,
        memberPhone: w.member.phone,
        joinedAt: w.createdAt,
      })),
      totalWaiting: waiting.length,
      available: !hasActiveBooking && !pendingConfirm && waiting.length === 0,
    },
  })
})

router.get('/member/:memberId', async (req: Request, res: Response) => {
  const memberId = Number(req.params.memberId)
  const waitlist = await prisma.waitlist.findMany({
    where: { memberId, status: { in: ['waiting', 'pending_confirm'] } },
    include: { schedule: { include: { trainer: true, store: true } } },
    orderBy: [{ status: 'desc' }, { createdAt: 'desc' }],
  })

  const result = await Promise.all(
    waitlist.map(async (w) => {
      let position = 0
      let totalWaiting = 0
      let currentTurn: any = null

      if (w.status === 'waiting') {
        const ahead = await prisma.waitlist.count({
          where: { scheduleId: w.scheduleId, status: 'waiting', priority: { lt: w.priority } },
        })
        position = ahead + 1
        totalWaiting = await prisma.waitlist.count({
          where: { scheduleId: w.scheduleId, status: 'waiting' },
        })
        if (position === 1) {
          const pending = await prisma.waitlist.findFirst({
            where: { scheduleId: w.scheduleId, status: 'pending_confirm' },
            include: { member: true },
          })
          if (!pending) {
            currentTurn = { type: 'next_up', message: '下一位就是您' }
          } else {
            currentTurn = {
              type: 'pending_other',
              message: `正在确认中：${pending.member.name}`,
              remainMinutes: pending.confirmExpireAt
                ? Math.max(0, Math.ceil((pending.confirmExpireAt.getTime() - Date.now()) / 60000))
                : 0,
            }
          }
        }
      } else if (w.status === 'pending_confirm') {
        currentTurn = { type: 'your_turn', message: '轮到您确认了！' }
      }

      return {
        id: w.id,
        scheduleId: w.scheduleId,
        date: w.schedule.date,
        startAt: w.schedule.startAt,
        endAt: w.schedule.endAt,
        trainerName: w.schedule.trainer.name,
        storeName: w.schedule.store.name,
        position,
        totalWaiting,
        status: w.status,
        confirmExpireAt: w.confirmExpireAt,
        remainMinutes: w.confirmExpireAt
          ? Math.max(0, Math.ceil((w.confirmExpireAt.getTime() - Date.now()) / 60000))
          : 0,
        currentTurn,
        joinedAt: w.createdAt,
      }
    })
  )

  res.json({
    data: result,
    meta: { confirmWindowMinutes: CONFIRM_WINDOW_MINUTES },
  })
})

export default router
