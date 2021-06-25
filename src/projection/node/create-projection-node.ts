import sync, { cancelSync, flushSync } from "framesync"
import { ResolvedValues } from "../../render/types"
import { SubscriptionManager } from "../../utils/subscription-manager"
import { copyBoxInto } from "../geometry/copy"
import { applyBoxDelta, applyTreeDeltas } from "../geometry/delta-apply"
import { calcBoxDelta } from "../geometry/delta-calc"
import { createBox, createDelta } from "../geometry/models"
import { translateAxis } from "../geometry/operations"
import { Box, Delta, Point } from "../geometry/types"
import { isDeltaZero } from "../geometry/utils"
import { scaleCorrectors } from "../styles/scale-correction"
import { buildProjectionTransform } from "../styles/transform"
import { eachAxis } from "../utils/each-axis"
import {
    IProjectionNode,
    LayoutUpdateData,
    LayoutUpdateHandler,
    ProjectionNodeConfig,
    ProjectionNodeOptions,
    Snapshot,
} from "./types"

export function createProjectionNode<I>({
    attachResizeListener,
    defaultParent,
    measureScroll,
    measureViewportBox,
    resetTransform,
}: ProjectionNodeConfig<I>) {
    return class ProjectionNode implements IProjectionNode<I> {
        instance: I

        root: IProjectionNode

        parent: IProjectionNode

        path: IProjectionNode[]

        children = new Set<IProjectionNode>()

        options: ProjectionNodeOptions = {}

        snapshot: Snapshot | undefined

        layout: Box | undefined

        layoutCorrected: Box

        scroll?: Point

        isLayoutDirty: boolean

        shouldResetTransform: boolean

        treeScale: Point = { x: 1, y: 1 } // TODO Lazy-initialise

        targetDelta?: Delta

        projectionDelta?: Delta

        target?: Box

        layoutWillUpdateListeners?: SubscriptionManager<VoidFunction>
        layoutDidUpdateListeners?: SubscriptionManager<LayoutUpdateHandler>

        constructor(parent?: IProjectionNode) {
            this.parent = parent
                ? parent
                : (defaultParent?.() as IProjectionNode)

            if (this.parent) this.parent.children.add(this)
            this.root = this.parent ? this.parent.root || this.parent : this
            this.path = this.parent ? [...this.parent.path, this.parent] : []

            if (attachResizeListener) {
            }
        }

        destructor() {
            this.parent?.children.delete(this)
            cancelSync.preRender(this.updateProjection)
        }

        /**
         * Lifecycles
         */
        mount(instance: I) {
            this.instance = instance
        }

        willUpdate(shouldNotifyListeners = true) {
            if (this.isLayoutDirty) return

            this.isLayoutDirty = true

            this.path.forEach((node) => {
                node.shouldResetTransform = true

                /**
                 * TODO: Check we haven't updated the scroll
                 * since the last didUpdate
                 */
                node.updateScroll()
            })

            this.updateSnapshot()

            console.log(this.snapshot)

            shouldNotifyListeners && this.layoutWillUpdateListeners?.notify()
        }

        // Note: Currently only running on root node
        didUpdate() {
            /**
             * Write
             */
            resetTreeTransform(this)

            /**
             * Read ==================
             */
            // Update layout measurements of updated children
            updateTreeLayout(this)

            /**
             * Write
             */
            // Notify listeners that the layout is updated
            notifyLayoutUpdate(this)

            // Flush any scheduled updates
            flushSync.update()
            flushSync.preRender()
            flushSync.render()
        }

        scheduleUpdateProjection() {
            sync.preRender(this.updateProjection, false, true)
        }

        updateProjection = () => {
            updateProjectionTree(this)
        }

        /**
         * Update measurements
         */
        updateSnapshot() {
            const visible = this.measure()
            this.snapshot = {
                visible,
                layout: this.removeElementScroll(visible!),
            }
        }

        updateLayout() {
            // TODO: Incorporate into a forwarded
            // scroll offset
            if (this.options.shouldMeasureScroll) {
                this.updateScroll()
            }

            if (!this.isLayoutDirty) return

            this.layout = this.removeElementScroll(this.measure())

            this.layoutCorrected = createBox()
            this.isLayoutDirty = false
        }

        updateScroll() {
            if (!measureScroll) return
            this.scroll = measureScroll(this.instance)
        }

        resetTransform() {
            if (
                resetTransform &&
                this.projectionDelta &&
                (this.isLayoutDirty || this.shouldResetTransform) &&
                !isDeltaZero(this.projectionDelta)
            ) {
                resetTransform(this.instance)
                this.shouldResetTransform = false
                // TODO: Trigger render to restore transform
            }
        }

        measure() {
            if (!measureViewportBox) return createBox()

            const box = measureViewportBox(this.instance)

            // Remove window scroll to give page-relative coordinates
            const { scroll } = this.root
            scroll && eachAxis((axis) => translateAxis(box[axis], scroll[axis]))

            return box
        }

        removeElementScroll(box: Box) {
            const boxWithoutScroll = createBox()
            copyBoxInto(boxWithoutScroll, box)

            // TODO: Keep a culmulative scroll offset rather
            // than loop through
            this.path.forEach((node) => {
                if (
                    node !== this.root &&
                    node.scroll &&
                    node.options.shouldMeasureScroll
                ) {
                    const { scroll } = node
                    eachAxis((axis) => {
                        translateAxis(boxWithoutScroll[axis], scroll[axis])
                    })
                }
            })

            return boxWithoutScroll
        }

        /**
         *
         */
        setTargetDelta(delta: Delta) {
            this.targetDelta = delta

            if (!this.projectionDelta) this.projectionDelta = createDelta()
            this.root.scheduleUpdateProjection()
        }

        setOptions(options: ProjectionNodeOptions) {
            this.options = options
        }

        /**
         * Frame calculations
         */
        resolveTargetDelta() {
            if (!this.targetDelta || !this.layout) return
            if (!this.target) this.target = createBox()

            copyBoxInto(this.target, this.layout)
            applyBoxDelta(this.target, this.targetDelta)
        }

        calcProjection() {
            if (!this.layout || !this.target || !this.projectionDelta) return

            /**
             * Reset the corrected box with the latest values from box, as we're then going
             * to perform mutative operations on it.
             */
            copyBoxInto(this.layoutCorrected, this.layout)

            /**
             * Apply all the parent deltas to this box to produce the corrected box. This
             * is the layout box, as it will appear on screen as a result of the transforms of its parents.
             */
            applyTreeDeltas(this.layoutCorrected, this.treeScale, this.path)

            /**
             * Update the delta between the corrected box and the target box before user-set transforms were applied.
             * This will allow us to calculate the corrected borderRadius and boxShadow to compensate
             * for our layout reprojection, but still allow them to be scaled correctly by the user.
             * It might be that to simplify this we may want to accept that user-set scale is also corrected
             * and we wouldn't have to keep and calc both deltas, OR we could support a user setting
             * to allow people to choose whether these styles are corrected based on just the
             * layout reprojection or the final bounding box.
             */
            calcBoxDelta(
                this.projectionDelta,
                this.layoutCorrected,
                this.target
            ) // origin)

            // TODO Make this event listener
            const { onProjectionUpdate } = this.options
            onProjectionUpdate && onProjectionUpdate()
        }

        getProjectionStyles(latest: ResolvedValues) {
            // TODO: Return lifecycle-persistent object
            const styles: ResolvedValues = {}

            if (!this.projectionDelta) return styles

            // Resolve crossfading props and viewport boxes
            // TODO: Apply user-set transforms to targetBox
            // TODO: Return persistent mutable object

            styles.transform = buildProjectionTransform(
                this.projectionDelta,
                this.treeScale
            )

            // TODO Move into stand-alone, testable function
            const { x, y } = this.projectionDelta
            styles.transformOrigin = `${x.origin * 100}% ${y.origin * 100}% 0`

            /**
             * Apply scale correction
             */
            for (const key in scaleCorrectors) {
                if (latest[key] === undefined) {
                    delete styles[key]
                    continue
                }

                const { correct, applyTo } = scaleCorrectors[key]
                const corrected = correct(latest[key], this)

                if (applyTo) {
                    const num = applyTo.length
                    for (let i = 0; i < num; i++) {
                        styles[applyTo[i]] = corrected
                    }
                } else {
                    styles[key] = corrected
                }
            }

            return styles
        }

        /**
         * Events
         *
         * TODO Replace this with a key-based lookup
         */
        onLayoutWillUpdate(handler: VoidFunction) {
            if (!this.layoutWillUpdateListeners) {
                this.layoutWillUpdateListeners = new SubscriptionManager()
            }
            return this.layoutWillUpdateListeners!.add(handler)
        }

        onLayoutDidUpdate(handler: (data: LayoutUpdateData) => void) {
            if (!this.layoutDidUpdateListeners) {
                this.layoutDidUpdateListeners = new SubscriptionManager()
            }
            return this.layoutDidUpdateListeners!.add(handler)
        }
    }
}

function updateTreeLayout(node: IProjectionNode) {
    node.updateLayout()
    node.children.forEach(updateTreeLayout)
}

function notifyLayoutUpdate(node: IProjectionNode) {
    const { layout, snapshot } = node

    if (layout && snapshot && node.layoutDidUpdateListeners) {
        const layoutDelta = createDelta()
        calcBoxDelta(layoutDelta, layout, snapshot.layout)

        const visualDelta = createDelta()
        calcBoxDelta(visualDelta, layout, snapshot.visible)

        node.layoutDidUpdateListeners.notify({
            layout,
            snapshot,
            delta: visualDelta,
            hasLayoutChanged: !isDeltaZero(layoutDelta),
        })
    }

    node.children.forEach(notifyLayoutUpdate)
}

function resetTreeTransform(node: IProjectionNode) {
    node.resetTransform()
    node.children.forEach(resetTreeTransform)
}

function updateProjectionTree(node: IProjectionNode) {
    resolveTreeTargetDeltas(node)
    calcTreeProjection(node)
}

function resolveTreeTargetDeltas(node: IProjectionNode) {
    node.resolveTargetDelta()
    node.children.forEach(resolveTreeTargetDeltas)
}

function calcTreeProjection(node: IProjectionNode) {
    node.calcProjection()
    node.children.forEach(calcTreeProjection)
}
