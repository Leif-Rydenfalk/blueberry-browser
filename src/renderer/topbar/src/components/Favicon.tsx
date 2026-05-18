import React, { useState } from "react";
import { Globe } from "lucide-react";
import { cn } from "@common/lib/utils";

interface FaviconProps {
    src?: string | null;
    className?: string;
}

export const Favicon: React.FC<FaviconProps> = ({ src, className = "size-4" }) => {
    const [error, setError] = useState(false);

    if (!src || error) {
        return <Globe className={cn("text-muted-foreground/60", className)} />;
    }

    return (
        <img
            src={src}
            className={cn("object-contain rounded-sm", className)}
            onError={() => setError(true)}
            alt=""
        />
    );
};