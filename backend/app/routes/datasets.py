import logging
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import db
from ..tables import Row, norm, parse_upload, strip_ext

router = APIRouter(tags=["datasets"])
log = logging.getLogger("jwork.datasets")

MAX_TEXT = 2_000_000       # roughly 2 MB of CSV text
MAX_B64 = 7_000_000        # roughly 5 MB of Excel file


class FilePayload(BaseModel):
    filename: str = Field(default="", max_length=200)
    content: str = Field(default="", max_length=MAX_TEXT)  # CSV text, read in the browser
    contentBase64: str = Field(default="", max_length=MAX_B64)  # Excel files travel as base64
    delimiter: str = Field(default=",", min_length=1, max_length=1)


class UploadRequest(FilePayload):
    name: str = Field(default="", max_length=80)
    # replace: save under `name`, replacing earlier data with that name (or creating it).
    # append:  add the rows to dataset `targetId` (columns must match).
    # new:     create `name`; refuse if it already exists.
    mode: Literal["replace", "append", "new"] = "replace"
    targetId: int | None = None


def read_file(req: FilePayload) -> tuple[list[str], list[Row], str | None]:
    try:
        return parse_upload(req.filename, req.content, req.contentBase64, req.delimiter)
    except ValueError as e:
        log.warning("upload rejected file=%r: %s", req.filename, e)
        raise HTTPException(status_code=422, detail=str(e)) from e


def find_matches(suggested: str, filename: str, columns: list[str]) -> list[dict]:
    """Existing datasets this file could be an update of: same name, or exactly the same columns."""
    want_names = {norm(suggested), norm(strip_ext(filename))} - {""}
    want_cols = sorted(norm(c) for c in columns)
    out = []
    for d in db.list_datasets():
        same_name = bool(want_names & {norm(d["name"]), norm(strip_ext(d["filename"]))})
        same_cols = sorted(norm(c) for c in d["columns"]) == want_cols
        if same_name or same_cols:
            out.append({"id": d["id"], "name": d["name"], "rowCount": d["rowCount"], "sameName": same_name, "sameColumns": same_cols})
    return out


@router.get("/datasets")
async def list_datasets() -> list[dict]:
    return db.list_datasets()


@router.post("/datasets/inspect")
async def inspect_upload(req: FilePayload) -> dict:
    """Read a file without saving it, and report which existing datasets it might update."""
    columns, rows, sheet = read_file(req)
    suggested = strip_ext(req.filename) or "dataset"
    return {
        "suggestedName": suggested,
        "columns": columns,
        "rowCount": len(rows),
        "sheet": sheet,
        "preview": rows[:5],
        "matches": find_matches(suggested, req.filename, columns),
    }


@router.post("/datasets")
async def upload_dataset(req: UploadRequest) -> dict:
    columns, rows, sheet = read_file(req)

    if req.mode == "append":
        target = db.get_dataset(req.targetId) if req.targetId is not None else None
        if target is None:
            raise HTTPException(status_code=404, detail="The dataset to add rows to was not found.")
        by_norm = {norm(c): c for c in columns}
        if sorted(by_norm) != sorted(norm(c) for c in target["columns"]):
            raise HTTPException(
                status_code=422,
                detail=f"The columns do not match “{target['name']}”. It has: {', '.join(target['columns'])}. The file has: {', '.join(columns)}.",
            )
        mapped = [{c: r.get(by_norm[norm(c)], "") for c in target["columns"]} for r in rows]
        saved = db.append_rows(target["id"], mapped)
        log.info("appended %d rows to dataset %r (now %d)", len(mapped), target["name"], saved["rowCount"])
        return saved

    name = req.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="Give the dataset a name.")
    if req.mode == "new" and any(norm(d["name"]) == norm(name) for d in db.list_datasets()):
        raise HTTPException(status_code=409, detail=f"A dataset named “{name}” already exists. Choose another name, or replace it.")
    saved = db.save_dataset(name, req.filename, columns, rows)
    log.info("saved dataset %r (%s) id=%s rows=%d columns=%s%s", saved["name"], req.mode, saved["id"], saved["rowCount"], columns, f" sheet={sheet!r}" if sheet else "")
    return saved


@router.get("/datasets/{dataset_id}")
async def get_dataset(dataset_id: int) -> dict:
    found = db.get_dataset(dataset_id)
    if found is None:
        raise HTTPException(status_code=404, detail="Dataset not found.")
    return found


@router.delete("/datasets/{dataset_id}")
async def delete_dataset(dataset_id: int) -> dict:
    if not db.delete_dataset(dataset_id):
        raise HTTPException(status_code=404, detail="Dataset not found.")
    return {"deleted": dataset_id}
