import { Router, Request, Response } from 'express'
import { prisma } from '../lib/prisma'
import dayjs from 'dayjs'

const router = Router()

router.get('/risk-overview', async (req: Request, res: Response) => {
  const { storeId, keyword, riskType, startDate, endDate } = req.query as Record<string, string>
  const periodStart = startDate ? dayjs(startDate).startOf('day') : dayjs().subtract(30, 'day').startOf('day')
  const periodEnd = endDate ? dayjs(endDate).endOf('day') : dayjs().endOf('day')
  const lowSlotThreshold = 5
  const cancelThreshold = 2
  const noShowThreshold = 1

  const members = await prisma.member.findMany({
    where: keyword
      ? { OR: [{ name: { contains: keyword } }, { phone: { contains: keyword } }] }
      : undefined,
    include: {
      packages: { include: { package: true } },
      bookings: {
        where: {
          createdAt: { gte: periodStart.toDate(), lte: periodEnd.toDate() },
          ...(storeId ? { storeId: Number(storeId) } : {}),
        },
        include: { schedule: true, noShow: true },
      },
      followUps: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
    orderBy: { id: 'asc' },
  })

  const now = new Date()
  const memberRisks: any[] = []

  for (const member of members) {
    const risks: string[] = []
    const riskDetails: Record<string, any> = {}

    const activePackages = member.packages.filter(
      p => p.remainSlots > 0 && (!p.expireAt || p.expireAt >= now)
    )
    const totalRemain = activePackages.reduce((s, p) => s + p.remainSlots, 0)
    const lowSlotPkg = activePackages.find(p => p.remainSlots <= lowSlotThreshold && p.remainSlots > 0)
    if (lowSlotPkg) {
      risks.push('low_slot')
      riskDetails.lowSlot = {
        remainSlots: totalRemain,
        packageName: lowSlotPkg.package.name,
        packageRemain: lowSlotPkg.remainSlots,
        urgency: lowSlotPkg.remainSlots <= 1 ? 'critical' : lowSlotPkg.remainSlots <= 3 ? 'high' : 'medium',
      }
    }

    const expiringSoonPkg = activePackages.find(
      p => p.expireAt && dayjs(p.expireAt).diff(now, 'day') <= 14 && dayjs(p.expireAt).diff(now, 'day') >= 0
    )
    if (expiringSoonPkg) {
      risks.push('expiring_soon')
      riskDetails.expiringSoon = {
        packageName: expiringSoonPkg.package.name,
        expireAt: expiringSoonPkg.expireAt,
        daysLeft: expiringSoonPkg.expireAt ? dayjs(expiringSoonPkg.expireAt).diff(now, 'day') : null,
      }
    }

    const cancelledBookings = member.bookings.filter(b => b.status === 'cancelled')
    if (cancelledBookings.length >= cancelThreshold) {
      risks.push('frequent_cancel')
      riskDetails.frequentCancel = {
        cancelCount: cancelledBookings.length,
        recentCancels: cancelledBookings.slice(0, 3).map(b => ({
          bookingId: b.id,
          date: b.schedule.date,
          startAt: b.schedule.startAt,
          reason: b.cancelReason,
        })),
      }
    }

    const noShowCount = member.bookings.filter(b => b.status === 'no_show').length
    if (noShowCount >= noShowThreshold) {
      risks.push('frequent_noshow')
      riskDetails.frequentNoShow = {
        noShowCount,
        recentNoShows: member.bookings
          .filter(b => b.status === 'no_show')
          .slice(0, 3)
          .map(b => ({
            bookingId: b.id,
            date: b.schedule.date,
            startAt: b.schedule.startAt,
            reason: b.noShow?.reason,
          })),
      }
    }

    const pendingUnconfirmed = member.bookings.find(
      b => b.status === 'booked' && dayjs(b.schedule.date).hour(Number(b.schedule.startAt.split(':')[0])).isAfter(now)
    )
    if (pendingUnconfirmed) {
      const startAt = dayjs(pendingUnconfirmed.schedule.date).hour(Number(pendingUnconfirmed.schedule.startAt.split(':')[0]))
      const hoursUntilStart = startAt.diff(now, 'hour')
      if (hoursUntilStart <= 4) {
        risks.push('pending_unconfirmed')
        riskDetails.pendingUnconfirmed = {
          bookingId: pendingUnconfirmed.id,
          date: pendingUnconfirmed.schedule.date,
          startAt: pendingUnconfirmed.schedule.startAt,
          hoursUntilStart,
        }
      }
    }

    if (risks.length === 0 && riskType) continue
    if (riskType && !risks.includes(riskType)) continue
    if (risks.length === 0 && !riskType && !keyword) continue

    memberRisks.push({
      memberId: member.id,
      memberName: member.name,
      memberPhone: member.phone,
      riskCount: risks.length,
      riskTypes: risks,
      riskDetails,
      latestFollowUp: member.followUps[0] || null,
    })
  }

  memberRisks.sort((a, b) => {
    if (b.riskCount !== a.riskCount) return b.riskCount - a.riskCount
    const aCritical = a.riskDetails.lowSlot?.urgency === 'critical' || false
    const bCritical = b.riskDetails.lowSlot?.urgency === 'critical' || false
    if (bCritical !== aCritical) return bCritical ? 1 : -1
    return 0
  })

  res.json({
    data: memberRisks,
    summary: {
      totalAtRisk: memberRisks.length,
      lowSlotCount: memberRisks.filter(r => r.riskTypes.includes('low_slot')).length,
      expiringSoonCount: memberRisks.filter(r => r.riskTypes.includes('expiring_soon')).length,
      frequentCancelCount: memberRisks.filter(r => r.riskTypes.includes('frequent_cancel')).length,
      frequentNoShowCount: memberRisks.filter(r => r.riskTypes.includes('frequent_noshow')).length,
      pendingUnconfirmedCount: memberRisks.filter(r => r.riskTypes.includes('pending_unconfirmed')).length,
      multiRiskCount: memberRisks.filter(r => r.riskCount >= 2).length,
    },
  })
})

router.post('/', async (req: Request, res: Response) => {
  const { memberId, followType, status, handler, remark } = req.body
  if (!memberId || !followType) return res.status(400).json({ error: 'memberId 和 followType 为必填' })

  const validTypes = ['low_slot', 'expiring_soon', 'frequent_cancel', 'frequent_noshow', 'pending_unconfirmed', 'other']
  if (!validTypes.includes(followType)) return res.status(400).json({ error: 'followType 不合法' })

  const validStatuses = ['pending', 'processing', 'resolved', 'ignored']
  if (status && !validStatuses.includes(status)) return res.status(400).json({ error: 'status 不合法' })

  const member = await prisma.member.findUnique({ where: { id: Number(memberId) } })
  if (!member) return res.status(404).json({ error: '会员不存在' })

  const followUp = await prisma.memberFollowUp.create({
    data: {
      memberId: Number(memberId),
      followType,
      status: status || 'pending',
      handler: handler || null,
      remark: remark || null,
    },
  })

  res.status(201).json({ data: followUp })
})

router.get('/member/:memberId', async (req: Request, res: Response) => {
  const memberId = Number(req.params.memberId)
  const { followType, status } = req.query as Record<string, string>

  const where: any = { memberId }
  if (followType) where.followType = followType
  if (status) where.status = status

  const followUps = await prisma.memberFollowUp.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  })

  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: { id: true, name: true, phone: true },
  })

  res.json({ data: { member, history: followUps } })
})

router.put('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  const { status, handler, remark } = req.body

  const validStatuses = ['pending', 'processing', 'resolved', 'ignored']
  if (status && !validStatuses.includes(status)) return res.status(400).json({ error: 'status 不合法' })

  try {
    const followUp = await prisma.memberFollowUp.update({
      where: { id },
      data: { status, handler, remark },
    })
    res.json({ data: followUp })
  } catch {
    res.status(404).json({ error: '跟进记录不存在' })
  }
})

router.get('/summary', async (_req: Request, res: Response) => {
  const [pendingCount, processingCount, resolvedCount] = await Promise.all([
    prisma.memberFollowUp.count({ where: { status: 'pending' } }),
    prisma.memberFollowUp.count({ where: { status: 'processing' } }),
    prisma.memberFollowUp.count({ where: { status: 'resolved' } }),
  ])

  res.json({
    data: {
      pendingCount,
      processingCount,
      resolvedCount,
      total: pendingCount + processingCount + resolvedCount,
    },
  })
})

export default router
