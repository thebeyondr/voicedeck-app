import {
  ClaimsByOwnerQuery,
  HypercertClient,
  HypercertIndexerInterface,
  HypercertMetadata,
  HypercertsStorage,
} from "@hypercerts-org/sdk";
import { Mutex } from "async-mutex";
import { Claim, Report } from "@/types";
import { getCMSReports, getFundedAmountByHCId } from "./directus";

let reports: Report[] | null = null;
const reportsMutex = new Mutex();

let hypercertClient: HypercertClient | null = null;

/**
 * Fetches reports either from the cache or by generating them if not already cached.
 * @returns A promise that resolves to an array of reports.
 * @throws Throws an error if fetching reports fails.
 */
export const fetchReports = async (): Promise<Report[]> => {
  if (!process.env.HC_OWNER_ADDRESS) {
    throw new Error("[server] Owner address environment variable is not set");
  }
  const ownerAddress = process.env.HC_OWNER_ADDRESS;

  try {
    if (reports) {
      console.log(
        "[server] Reports already exist, no need to fetch from remote"
      );
      console.log(`[server] Existing reports: ${reports.length}`);
    } else {
      console.log(
        `[server] Fetching reports from remote using owner address: ${ownerAddress}`
      );
      const claims = await getHypercertClaims(
        ownerAddress,
        getHypercertClient().indexer
      );

      reports = await Promise.all(
        claims.map(async (claim, index) => {
          const metadata = await getHypercertMetadata(
            claim.uri as string,
            getHypercertClient().storage
          );

          const fromCMS = await getCMSReports();
          const cmsReport = fromCMS.find(
            (cmsReport) => cmsReport.title === metadata.name
          );
          if (!cmsReport) {
            throw new Error(
              `[server] CMS content for report titled '${metadata.name}' not found.`
            );
          }

          return {
            hypercertId: claim.id,
            title: metadata.name,
            summary: metadata.description,
            image: metadata.image,
            originalReportUrl: metadata.external_url,
            // first indice of `metadata.properties` holds the value of the state
            state: metadata.properties?.[0].value,
            category: metadata.hypercert?.work_scope.value?.[0],
            workTimeframe: metadata.hypercert?.work_timeframe.display_value,
            impactScope: metadata.hypercert?.impact_scope.display_value,
            impactTimeframe: metadata.hypercert?.impact_timeframe.display_value,
            contributors: metadata.hypercert?.contributors.value?.map(
              (name) => name
            ),

            // properties stored in CMS
            cmsId: cmsReport.id,
            status: cmsReport.status,
            dateCreated: cmsReport.date_created,
            slug: cmsReport.slug,
            story: cmsReport.story,
            bcRatio: cmsReport.bc_ratio,
            villagesImpacted: cmsReport.villages_impacted,
            peopleImpacted: cmsReport.people_impacted,
            verifiedBy: cmsReport.verified_by,
            dateUpdated: cmsReport.date_updated,
            byline: cmsReport.byline,
            totalCost: Number(cmsReport.total_cost),
            fundedSoFar: await getFundedAmountByHCId(claim.id),
          } as Report;
        })
      );
      console.log(`[server] total reports: ${reports.length}`);
    }

    return reports;
  } catch (error) {
    console.error(`[server] Failed to fetch reports: ${error}`);
    throw new Error(`[server] Failed to fetch reports: ${error}`);
  }
};

/**
 * Fetches a report by its slug.
 * @param slug - The slug of the report to fetch.
 * @returns A promise that resolves to the report.
 * @throws Throws an error if the report with the specified slug is not found.
 */
export const fetchReportBySlug = async (slug: string): Promise<Report> => {
  try {
    const reports = await fetchReports();

    const foundReport = reports.find((report: Report) => report.slug === slug);
    if (!foundReport) {
      throw new Error(`[server] Report with slug '${slug}' not found.`);
    }

    return foundReport;
  } catch (error) {
    console.error(`[server] Failed to get report by slug ${slug}: ${error}`);
    throw new Error(`[server] Failed to get report by slug ${slug}: ${error}`);
  }
};

export const fetchReportByHCId = async (
  hypercertId: string
): Promise<Report> => {
  try {
    const reports = await fetchReports();

    const foundReport = reports.find(
      (report: Report) => report.hypercertId === hypercertId
    );
    if (!foundReport) {
      throw new Error(
        `[server] Report with hypercert Id '${hypercertId}' not found.`
      );
    }

    return foundReport;
  } catch (error) {
    throw new Error(
      `[server] Failed to get report with hypercert Id '${hypercertId}': ${error}`
    );
  }
};

export const getReports = (): Report[] => {
  if (reports) {
    return reports;
  }
  return [];
};

/**
 * Retrieves the singleton instance of the HypercertClient.
 * @returns The HypercertClient instance.
 */
export const getHypercertClient = (): HypercertClient => {
  if (hypercertClient) {
    return hypercertClient;
  }
  hypercertClient = new HypercertClient({ chain: { id: 11155111 } }); // Sepolia testnet

  return hypercertClient;
};

/**
 * Fetches the claims owned by the specified address from the Hypercert indexer.
 * @param ownerAddress - The address of the owner of the claims.
 * @param indexer - An instance of HypercertIndexer to retrieve claims from the [Graph](https://thegraph.com/docs/en/)
 * @returns A promise that resolves to an array of claims.
 * @throws Will throw an error if the owner address is not set or the claims cannot be fetched.
 */
export const getHypercertClaims = async (
  ownerAddress: string,
  indexer: HypercertIndexerInterface
): Promise<Claim[]> => {
  let claims: Claim[] | null;

  console.log(`[Hypercerts] Fetching claims owned by ${ownerAddress}`);
  try {
    // see graphql query: https://github.com/hypercerts-org/hypercerts/blob/d7f5fee/sdk/src/indexer/queries/claims.graphql#L1-L11
    const response = await indexer.claimsByOwner(ownerAddress as string);
    claims = (response as ClaimsByOwnerQuery).claims as Claim[];
    console.log(`[Hypercerts] Fetched claims: ${claims ? claims.length : 0}`);

    return claims;
  } catch (error) {
    console.error(
      `[Hypercerts] Failed to fetch claims owned by ${ownerAddress}: ${error}`
    );
    throw new Error(
      `[Hypercerts] Failed to fetch claims owned by ${ownerAddress}: ${error}`
    );
  }
};

/**
 * Retrieves the metadata for a given claim URI from IPFS.
 * @param claimUri - The IPFS URI of the claim for which metadata is to be fetched.
 * @param storage - An instance of HypercertsStorage to retrieve metadata from IPFS.
 * @returns A promise that resolves to the metadata of the claim.
 * @throws Will throw an error if the metadata cannot be fetched.
 */
export const getHypercertMetadata = async (
  claimUri: string,
  storage: HypercertsStorage
): Promise<HypercertMetadata> => {
  let metadata: HypercertMetadata | null;

  try {
    const response = await storage.getMetadata(claimUri);
    metadata = response;

    return metadata;
  } catch (error) {
    console.error(
      `[Hypercerts] Failed to fetch metadata of ${claimUri}: ${error}`
    );
    throw new Error(
      `[Hypercerts] Failed to fetch metadata of ${claimUri}: ${error}`
    );
  }
};

// update the fundedSoFar field of the report
export const updateFundedAmount = async (
  hypercertId: string,
  amount: number
): Promise<void> => {
  const release = await reportsMutex.acquire();

  try {
    const reports = getReports();
    const report = reports.find((r) => r.hypercertId === hypercertId);
    if (report) {
      report.fundedSoFar += amount;
    }
  } finally {
    release();
  }
};
