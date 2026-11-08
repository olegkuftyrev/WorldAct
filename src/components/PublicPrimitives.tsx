import type { ReactNode } from "react";
export const Icon = ({name,...props}:{name:string;className?:string}) => <span {...props} aria-hidden="true" className={`dashicons dashicons-${name} ${props.className || ""}`} />;
export const Brand = () => <span className="worldact-mark" aria-hidden="true">W</span>;
export const errorText = (error:unknown) => error instanceof Error ? error.message : "Something went wrong. Please try again.";
export function Notice({children,error=false,onDismiss}:{children:ReactNode;error?:boolean;onDismiss?:()=>void}) {
 return <div role={error ? "alert" : "status"} className={`notice notice-${error ? "error" : "success"} ${onDismiss ? "is-dismissible" : ""}`}><p>{children}</p>{onDismiss && <button type="button" aria-label="Dismiss notice" className="notice-dismiss" onClick={onDismiss}><span className="screen-reader-text">Dismiss</span></button>}</div>;
}
export function ResourceState({loading,error,retry}:{loading:boolean;error:string;retry?:()=>void}) {
 return error ? <Notice error>{error}{" "}{retry && <button className="button-link" onClick={retry}>Try again</button>}</Notice> : loading ? <p className="loading-state"><span className="spinner is-active"/>Loading…</p> : null;
}
