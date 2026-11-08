import { lazy, Suspense, useEffect, useState, useRef } from "react";
import { useLocation } from "react-router-dom";
import type { PublicDocumentModel } from "../../shared/public-document";
import { Brand } from "../components/PublicPrimitives";
import PublicDocumentController from "./PublicDocumentController";
import { exposePublicRoot, gatePublicRoot, installPublicLifecycle, isFrameworkPath, retirePublicOwnership } from "./publicOwnership";
const FrameworkApplication = lazy(() => import("../App"));
export default function PublicApplication({ initialModel = null, initialError = "", applicationDocument = false }: {
    initialModel?: PublicDocumentModel | null;
    initialError?: string;
    applicationDocument?:boolean;
}) {
    const location = useLocation(),initialPath=useRef(location.pathname+location.search),framework = isFrameworkPath(location.pathname) || applicationDocument && initialPath.current===location.pathname+location.search;
    const [generation, setGeneration] = useState(() => window.__worldactPublicLifecycle?.generation || 0);
    const [seed, setSeed] = useState(initialModel), [seedError, setSeedError] = useState(initialError);
    useEffect(() => { setSeed(null); setSeedError(""); }, []);
    useEffect(() => {
        installPublicLifecycle();
        const session = () => { retirePublicOwnership(); setGeneration(window.__worldactPublicLifecycle!.generation); };
        const retire = () => setGeneration(window.__worldactPublicLifecycle!.generation);
        const restore = () => { retirePublicOwnership(); setGeneration(window.__worldactPublicLifecycle!.generation); };
        window.addEventListener("worldact-session-change", session);
        window.addEventListener("worldact-public-retire", retire);
        window.addEventListener("worldact-public-restore", restore);
        return () => { window.removeEventListener("worldact-session-change", session); window.removeEventListener("worldact-public-retire", retire); window.removeEventListener("worldact-public-restore", restore); };
    }, []);
    return framework ? <Suspense fallback={<div className="initial-loading"><Brand /><p>Loading WorldAct…</p></div>}><FrameworkApplication key={generation} onSessionReady={exposePublicRoot}/></Suspense> : <PublicDocumentController initialModel={seed} initialError={seedError} generation={generation}/>;
}
