function clamp(n, min, max) {
  const v = Number.isFinite(Number(n)) ? Number(n) : 0;
  return Math.max(min, Math.min(max, v));
}

function tierFromApprovalScore(score) {
  if (score >= 85) return { tierLevel: "Tier 1", decision: "Approved" };
  if (score >= 70) return { tierLevel: "Tier 2", decision: "Approved" };
  if (score >= 60) return { tierLevel: "Conditional", decision: "Conditional" };
  return { tierLevel: "Reject", decision: "Rejected" };
}

function computeApprovalScore(application) {
  const years = clamp(application.yearsOfExperience, 0, 60);
  const workforce = String(application.workforceSize || "");
  const hasW9 = String(application.w9Status || application.w9Submitted || "").toLowerCase().includes("provided") || application.w9Submitted === true;
  const hasCOI = String(application.coiStatus || application.coiProvided || "").toLowerCase().includes("provided") || application.coiProvided === true;
  const osha = String(application.oshaCompliance || "").toLowerCase() === "yes" || application.oshaConfirmed === true;
  const licensed = String(application.stateLicense || "").toLowerCase() === "licensed";

  const complianceRaw = (hasCOI ? 60 : 0) + (hasW9 ? 25 : 0) + (osha ? 10 : 0) + (licensed ? 5 : 0);
  const complianceScore = clamp(Math.round((complianceRaw / 100) * 25), 0, 25);

  const experienceRaw = years >= 10 ? 100 : years >= 7 ? 85 : years >= 4 ? 70 : years >= 2 ? 55 : years >= 1 ? 40 : 20;
  const experienceScore = clamp(Math.round((experienceRaw / 100) * 25), 0, 25);

  const capacityRaw =
    workforce.includes("20+") ? 100 :
    workforce.includes("11") ? 85 :
    workforce.includes("6") ? 70 :
    workforce.includes("2") ? 55 :
    workforce.includes("Self") ? 45 :
    45;
  const capacityScore = clamp(Math.round((capacityRaw / 100) * 20), 0, 20);

  const professionalismRaw = (osha ? 70 : 35) + (String(application.workAuthorization || "").toLowerCase() === "yes" ? 30 : 0);
  const professionalismScore = clamp(Math.round((professionalismRaw / 100) * 15), 0, 15);

  const financialRaw = hasW9 ? 80 : 30;
  const financialScore = clamp(Math.round((financialRaw / 100) * 15), 0, 15);

  const total = complianceScore + experienceScore + capacityScore + professionalismScore + financialScore;
  const tier = tierFromApprovalScore(total);

  return {
    total,
    tierLevel: tier.tierLevel,
    decision: tier.decision,
    breakdown: {
      complianceScore,
      experienceScore,
      capacityScore,
      professionalismScore,
      financialScore,
    },
  };
}

function computeProjectRating(input) {
  const quality = clamp(input.quality, 0, 30);
  const timeliness = clamp(input.timeliness, 0, 20);
  const communication = clamp(input.communication, 0, 15);
  const compliance = clamp(input.compliance, 0, 15);
  const clientSatisfaction = clamp(input.clientSatisfaction, 0, 20);
  const total = quality + timeliness + communication + compliance + clientSatisfaction;
  return {
    total,
    parts: { quality, timeliness, communication, compliance, clientSatisfaction },
  };
}

function performanceTierFromAverage(avg) {
  if (avg >= 90) return "Priority Allocation";
  if (avg >= 80) return "Standard Allocation";
  if (avg >= 70) return "Limited Allocation";
  return "Flag for Review";
}

function computeReliabilityIndex({ performanceAvg, responseRate, complianceOk }) {
  const perf = clamp(performanceAvg, 0, 100);
  const resp = clamp(responseRate, 0, 1);
  const comp = complianceOk ? 1 : 0;
  return perf * 0.7 + resp * 100 * 0.2 + comp * 100 * 0.1;
}

function isExpiringWithinDays(dateISO, days) {
  if (!dateISO) return false;
  const d = new Date(dateISO);
  if (Number.isNaN(d.getTime())) return false;
  const now = Date.now();
  const diffDays = (d.getTime() - now) / (1000 * 60 * 60 * 24);
  return diffDays >= 0 && diffDays <= days;
}

function isExpired(dateISO) {
  if (!dateISO) return false;
  const d = new Date(dateISO);
  if (Number.isNaN(d.getTime())) return false;
  return d.getTime() < Date.now();
}

function evaluateProbation(contractor) {
  const lastScores = contractor.performance?.recentProjectScores || [];
  const hasTwoLow = lastScores.length >= 2 && lastScores[lastScores.length - 1] < 75 && lastScores[lastScores.length - 2] < 75;
  const complianceExpired = isExpired(contractor.compliance?.insuranceExpiryDate) || isExpired(contractor.compliance?.licenseExpiryDate);
  const safetyViolation = (contractor.flags?.safetyViolations || 0) > 0;
  const complaint = (contractor.flags?.verifiedComplaints || 0) > 0;
  const noResponseTrigger = (contractor.responseHistory?.noResponseStreak || 0) >= 3;

  const triggered = hasTwoLow || complianceExpired || safetyViolation || complaint || noResponseTrigger;
  if (!triggered) return contractor;

  const now = new Date();
  const end = new Date(now.getTime() + 45 * 24 * 60 * 60 * 1000);
  return {
    ...contractor,
    status: contractor.status && contractor.status.startsWith("Suspended") ? contractor.status : "Probation – Performance Review",
    probation: contractor.probation || { startDate: now.toISOString(), endDate: end.toISOString(), active: true },
  };
}

function scoreAllocation({ contractor, tradeCategory, region }) {
  if (!contractor) return { eligible: false, score: 0 };
  const tradeMatch = String(contractor.tradeCategory || "") === String(tradeCategory || "");
  const regions = Array.isArray(contractor.regionsCovered) ? contractor.regionsCovered : String(contractor.regionsCovered || "").split(",").map((s) => s.trim()).filter(Boolean);
  const regionMatch = regions.some((r) => r.toLowerCase() === String(region || "").toLowerCase());
  if (!tradeMatch || !regionMatch) return { eligible: false, score: 0 };

  const performance = clamp(contractor.performance?.averageScore || 0, 0, 100);
  const tierWeight = contractor.tierLevel === "Tier 1" ? 100 : contractor.tierLevel === "Tier 2" ? 80 : contractor.tierLevel === "Conditional" ? 60 : 0;
  const responseRate = clamp(contractor.responseHistory?.responseRate || 0, 0, 1) * 100;
  const availability = contractor.availability === "Available" ? 100 : contractor.availability === "Limited" ? 60 : 30;
  const complianceOk = contractor.compliance?.w9Submitted && contractor.compliance?.oshaConfirmed && !isExpired(contractor.compliance?.insuranceExpiryDate);
  const compliance = complianceOk ? 100 : 40;

  const score =
    performance * 0.4 +
    tierWeight * 0.2 +
    responseRate * 0.15 +
    availability * 0.15 +
    compliance * 0.1;

  const reliabilityIndex = computeReliabilityIndex({
    performanceAvg: performance,
    responseRate: clamp(contractor.responseHistory?.responseRate || 0, 0, 1),
    complianceOk,
  });

  return { eligible: true, score, reliabilityIndex };
}

module.exports = {
  computeApprovalScore,
  computeProjectRating,
  performanceTierFromAverage,
  evaluateProbation,
  isExpiringWithinDays,
  isExpired,
  scoreAllocation,
  tierFromApprovalScore,
  computeReliabilityIndex,
};

