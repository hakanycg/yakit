import { useEffect, useState } from "react";
import { getCurrentStationId, setCurrentStationId, subscribeStationId } from "./stationScope";

export function useCurrentStationId(): [number | null, (id: number | null) => void] {
  const [id, setId] = useState<number | null>(getCurrentStationId());

  useEffect(() => subscribeStationId(setId), []);

  return [id, setCurrentStationId];
}
