import fnv from "fnv-plus";
import Serializable from "./../encoding/Serializable";

/**
 * Special implementation of the Map API that internally uses ArrayBuffers for it's data storage. These buffers can be
 * easily transferred between threads with a zero-copy cost, which allows to gain a much higher communication speed
 * between threads. You need to call `getBuffers()` and `setBuffers()` and manually transfer the buffers for this map
 * between threads to use this benefits.
 *
 * NOTE: When no support for SharedArrayBuffers is available, this map will automatically fall back to regular
 * ArrayBuffers, which can also be transferred between threads (but cannot be used by multiple threads at the same
 * time).
 *
 * Note: This Map currently does not support deleting items or changing the values that belong to a key since this
 * would require extensive memory alignment and management.
 *
 * @author Pieter Verschaffelt
 */
export default class ShareableMap<K, V> extends Map<K, V> {
    // The default load factor to which this map should adhere
    private static readonly LOAD_FACTOR = 0.75;
    // Minimum ratio of (used space / total space) in the data table. This ratio indicates what percentage of the
    // total space should be wasted, before we start to defragment the data table.
    private static readonly MIN_DEFRAG_FACTOR = 0.5;
    // How many bytes does one int use? (32 bits at this point)
    private static readonly INT_SIZE = 4;
    // We never use 0 as a valid index value, and thus this number is used to identify free space / unused blocks.
    private static readonly INVALID_VALUE = 0;
    // The first byte in the data array is never used
    private static readonly INITIAL_DATA_OFFSET = 4;
    // How many bytes for a data object are reserved for metadata? (e.g. pointer to next block, key length,
    // value length).
    private static readonly DATA_OBJECT_OFFSET = 20;
    private static readonly INDEX_TABLE_OFFSET = 20;

    // Offsets for the different metadata entries that are kept in the index table.
    private static readonly INDEX_SIZE_OFFSET = 0;
    private static readonly INDEX_USED_BUCKETS_OFFSET = 4;
    private static readonly INDEX_FREE_START_INDEX_OFFSET = 8;
    private static readonly INDEX_DATA_ARRAY_SIZE_OFFSET = 12;
    private static readonly INDEX_TOTAL_USED_SPACE_OFFSET = 16;

    private index!: ArrayBuffer;
    private data!: ArrayBuffer;

    private indexView!: DataView;
    private dataView!: DataView;

    private textEncoder: TextEncoder = new TextEncoder();
    private textDecoder: TextDecoder = new TextDecoder();


    /**
     * Construct a new ShareableMap.
     *
     * @param expectedSize How many items are expected to be stored in this map? Setting this to a good estimate from
     * the beginning is important not to trash performance.
     * @param averageBytesPerValue What's the expected average size of one serialized value that will be stored in this
     * map?
     * @param serializer Custom serializer to convert the objects stored in this map as a value to an ArrayBuffer and
     * vice-versa.
     */
    constructor(
        expectedSize: number = 1024,
        averageBytesPerValue: number = 256,
        private readonly serializer?: Serializable<V>
    ) {
        super();
        this.reset(expectedSize, averageBytesPerValue);
    }

    /**
     * Get the internal buffers that represent this map and that can be transferred without cost between threads. Use
     * setBuffers() to rebuild a ShareableMap after the buffers have been transferred.
     */
    public getBuffers(): ArrayBuffer[] {
        return [this.index, this.data];
    }

    /**
     * Set the internal buffers that represent this map and that can be transferred without cost between threads.
     *
     * @param indexBuffer Index table buffer that's used to keep track of which values are stored where in the
     * dataBuffer.
     * @param dataBuffer Portion of memory in which all the data itself is stored.
     */
    public setBuffers(indexBuffer: ArrayBuffer, dataBuffer: ArrayBuffer) {
        this.index = indexBuffer;
        this.indexView = new DataView(this.index);
        this.data = dataBuffer;
        this.dataView = new DataView(this.data);
    }

    [Symbol.iterator](): IterableIterator<[K, V]> {
        return this.entries();
    }

    *entries(): IterableIterator<[K, V]> {
        for (let i = 0; i < this.buckets; i++) {
            let dataPointer = this.indexView.getUint32(ShareableMap.INDEX_TABLE_OFFSET + i * ShareableMap.INT_SIZE);
            while (dataPointer !== 0) {
                const key = this.readTypedKeyFromDataObject(dataPointer);
                const value = this.readValueFromDataObject(dataPointer);
                yield [key, value];
                dataPointer = this.dataView.getUint32(dataPointer);
            }
        }
    }

    *keys(): IterableIterator<K> {
        for (let i = 0; i < this.buckets; i++) {
            let dataPointer = this.indexView.getUint32(ShareableMap.INDEX_TABLE_OFFSET + i * ShareableMap.INT_SIZE);
            while (dataPointer !== 0) {
                yield this.readTypedKeyFromDataObject(dataPointer);
                dataPointer = this.dataView.getUint32(dataPointer);
            }
        }
    }

    *values(): IterableIterator<V> {
        for (let i = 0; i < this.buckets; i++) {
            let dataPointer = this.indexView.getUint32(ShareableMap.INDEX_TABLE_OFFSET + i * 4);
            while (dataPointer !== 0) {
                yield this.readValueFromDataObject(dataPointer);
                dataPointer = this.dataView.getUint32(dataPointer);
            }
        }
    }

    clear(expectedSize: number = 1024, averageBytesPerValue: number = 256): void {
        this.reset(expectedSize, averageBytesPerValue);
    }

    delete(key: K): boolean {
        const stringKey = this.stringifyElement<K>(key);
        const [hash, bucket] = this.computeHashAndBucket(stringKey);

        const bucketLink = this.indexView.getUint32(bucket + ShareableMap.INDEX_TABLE_OFFSET);
        const returnValue = this.findValue(bucketLink, stringKey, hash);

        if (!returnValue) {
            // The value that should be deleted was not found, and thus cannot be deleted.
            return false;
        }

        const [startPos, value] = returnValue;
        const keyLength = this.dataView.getUint32(startPos + 4);
        const valueLength = this.dataView.getUint32(startPos + 8);

        // Remove value from IndexArray
        const nextBlock = this.dataView.getUint32(startPos);
        // First check if the block that the bucket directly points to is already the block we are looking for
        if (bucketLink === startPos) {
            this.indexView.setUint32(bucket + ShareableMap.INDEX_TABLE_OFFSET, nextBlock);
        } else {
            let previousBlock = bucketLink;
            let currentBlock = this.dataView.getUint32(bucketLink);
            while (this.dataView.getUint32(currentBlock + 16) !== hash) {
                previousBlock = currentBlock;
                currentBlock = this.dataView.getUint32(currentBlock);
            }
            this.dataView.setUint32(previousBlock, nextBlock);
        }

        this.spaceUsedInDataPartition -= (ShareableMap.DATA_OBJECT_OFFSET + keyLength + valueLength);

        // One element has been removed from the map, thus we need to decrease the size of the map.
        this.decreaseSize();
        return true;
    }

    forEach(callbackfn: (value: V, key: K, map: Map<K, V>) => void, thisArg?: any): void {
        super.forEach(callbackfn, thisArg);
    }

    get(key: K): V | undefined {
        let stringKey = this.stringifyElement<K>(key);
        const [hash, bucket] = this.computeHashAndBucket(stringKey);

        const returnValue = this.findValue(
            this.indexView.getUint32(bucket + ShareableMap.INDEX_TABLE_OFFSET),
            stringKey,
            hash
        );

        if (returnValue) {
            return returnValue[1];
        }

        return undefined;
    }

    has(key: K): boolean {
        return this.get(key) !== undefined;
    }

    set(key: K, value: V): this {
        // Should we add a new entry or is there already an entry present (which we need to remove first)?
        if (this.has(key)) {
            this.delete(key);
        }

        const stringKey: string = this.stringifyElement<K>(key);
        const [hash, bucket] = this.computeHashAndBucket(stringKey);

        // Pointer to next block is empty at this point
        const startPos = this.storeDataBlock(key, value, hash);
        // Increase size of the map since we added a new element.
        this.increaseSize();

        const bucketPointer = this.indexView.getUint32(bucket + ShareableMap.INDEX_TABLE_OFFSET);
        if (bucketPointer === 0) {
            this.incrementBucketsInUse();
            this.indexView.setUint32(bucket + ShareableMap.INDEX_TABLE_OFFSET, startPos);
        } else {
            // Update linked list pointers
            this.updateLinkedPointer(bucketPointer, startPos, this.dataView);
        }

        // If the load factor exceeds the recommended value, we need to rehash the map to make sure performance stays
        // acceptable.
        if ((this.getBucketsInUse() / this.buckets) >= ShareableMap.LOAD_FACTOR) {
            this.doubleIndexStorage();
        }

        return this;
    }

    get size() {
        // Size is being stored in the first 4 bytes of the index table
        return this.indexView.getUint32(ShareableMap.INDEX_SIZE_OFFSET);
    }

    /**
     * @return The amount of buckets that are currently available in this map (either taken or non-taken, the total
     * number of buckets is returned).
     */
    private get buckets() {
        return (this.indexView.byteLength - ShareableMap.INDEX_TABLE_OFFSET) / ShareableMap.INT_SIZE;
    }

    /**
     * @return The amount of buckets that currently point to a data object.
     */
    private getBucketsInUse() {
        return this.indexView.getUint32(ShareableMap.INDEX_USED_BUCKETS_OFFSET);
    }

    /**
     * Increase the amount of buckets that currently point to a data object by one.
     */
    private incrementBucketsInUse() {
        return this.indexView.setUint32(ShareableMap.INDEX_USED_BUCKETS_OFFSET, this.getBucketsInUse() + 1);
    }

    /**
     * At what position in the data-array does the next block of free space start? This position is returned as number
     * of bytes since the start of the array.
     */
    private get freeStart() {
        // At what position in the data table does the free space start?
        return this.indexView.getUint32(ShareableMap.INDEX_FREE_START_INDEX_OFFSET);
    }

    /**
     * Update the position where the next block of free space in the data array starts.
     *
     * @param position The new position that should be set. Must indicate the amount of bytes from the start of the
     * data array.
     */
    private set freeStart(position) {
        this.indexView.setUint32(ShareableMap.INDEX_FREE_START_INDEX_OFFSET, position);
    }

    /**
     * @return Total current length of the data array in bytes.
     */
    private get dataSize() {
        return this.indexView.getUint32(ShareableMap.INDEX_DATA_ARRAY_SIZE_OFFSET);
    }

    /**
     * Update the total length of the data array.
     *
     * @param size New length value, in bytes.
     */
    private set dataSize(size) {
        this.indexView.setUint32(ShareableMap.INDEX_DATA_ARRAY_SIZE_OFFSET, size);
    }

    /**
     * Increase the size counter by one. This counter keeps track of how many items are currently stored in this map.
     */
    private increaseSize() {
        this.indexView.setUint32(ShareableMap.INDEX_SIZE_OFFSET, this.size + 1);
    }

    private decreaseSize() {
        this.indexView.setUint32(ShareableMap.INDEX_SIZE_OFFSET, this.size - 1);
    }

    private get spaceUsedInDataPartition(): number {
        return this.indexView.getUint32(ShareableMap.INDEX_TOTAL_USED_SPACE_OFFSET);
    }

    /**
     * Update the amount of bytes in the data array that are currently in use. These can be used to detect whether we
     * need to perform a defragmentation step or not.
     *
     * @param size New amount of bytes from the data array that's currently in use.
     */
    private set spaceUsedInDataPartition(size: number) {
        this.indexView.setUint32(ShareableMap.INDEX_TOTAL_USED_SPACE_OFFSET, size);
    }

    /**
     * Returns the total amount of bytes that are available in the data space.
     */
    private get totalDataArraySize(): number {
        return this.indexView.getUint32(ShareableMap.INDEX_DATA_ARRAY_SIZE_OFFSET);
    }

    private set totalDataArraySize(size: number) {
        this.indexView.setUint32(ShareableMap.INDEX_DATA_ARRAY_SIZE_OFFSET, size);
    }

    /**
     * Allocate a new buffer with a given capacity. This function will always try to allocate a SharedArrayBuffer (that
     * can be used by multiple threads simultaneously). If SharedArrayBuffer's are not supported by the context in which
     * this map is being used, a regular ArrayBuffer (that still can be transferred between threads) is used.
     *
     * A warning is printed to the console if this method had to fallback to regular ArrayBuffers.
     */
    private static allocateBuffer(bytes: number): ArrayBuffer {
        try {
            return new SharedArrayBuffer(bytes);
        } catch (error) {
            console.warn("Fallback to regular ArrayBuffer...");
            return new ArrayBuffer(bytes);
        }
    }

    /**
     * Convert a given element with type T to a string. If no custom serializer has been set for this map, the built-in
     * JSON.stringify function will be used.
     *
     * @param el The element that should be converted into a string.
     */
    private stringifyElement<T>(el: T): string {
        let stringVal: string;
        if (typeof el !== "string") {
            // TODO take into account the serializer of it is set.
            stringVal = JSON.stringify(el);
        } else {
            stringVal = el;
        }
        return stringVal;
    }

    private computeHashAndBucket(key: string): [number, number] {
        const hash: number = fnv.fast1a32(key);
        // Bucket in which this value should be stored.
        const bucket = (hash % this.buckets) * ShareableMap.INT_SIZE;
        return [hash, bucket];
    }

    /**
     * Iterate over all objects in the index buffer and reposition them in the data buffer. All objects should be stored
     * contiguous in the data buffer. This is an expensive operation that involves allocating a new collection of bytes,
     * copying and moving data around and releasing this block again from memory.
     */
    private defragment() {
        const newData: ArrayBuffer = ShareableMap.allocateBuffer(this.dataSize);
        const newView = new DataView(newData);

        let newOffset = ShareableMap.INITIAL_DATA_OFFSET;

        for (let bucket = 0; bucket < this.buckets; bucket++) {
            // Copy all objects associated with one bucket to a new data buffer.
            let dataPointer = this.indexView.getUint32(ShareableMap.INDEX_TABLE_OFFSET + bucket * ShareableMap.INT_SIZE);
            // This bucket is being set and thus the pointer in the indexview should be updated.
            this.indexView.setUint32(ShareableMap.INDEX_TABLE_OFFSET + bucket * ShareableMap.INT_SIZE, 0);

            while (dataPointer !== 0) {
                // Store key length
                let totalLength = this.dataView.getUint32(dataPointer + 4);
                // Store value length
                totalLength += this.dataView.getUint32(dataPointer + 8);
                // Keep track of the metadata for this block.
                totalLength += ShareableMap.DATA_OBJECT_OFFSET;

                for (let i = 0; i < totalLength; i++) {
                    newView.setUint8(newOffset + i, this.dataView.getUint8(dataPointer + 8 + i));
                }

                // Pointer to next block is zero
                newView.setUint32(newOffset, 0);

                const currentBucketLink = this.indexView.getUint32(ShareableMap.INDEX_TABLE_OFFSET + bucket * ShareableMap.INT_SIZE);
                if (currentBucketLink === 0) {
                    this.indexView.setUint32(ShareableMap.INDEX_TABLE_OFFSET + bucket * ShareableMap.INT_SIZE, newOffset);
                } else {
                    // We need to follow the links from the first block here and update those.
                    this.updateLinkedPointer(currentBucketLink, newOffset, newView);
                }

                newOffset += totalLength;
                dataPointer = this.dataView.getUint32(dataPointer);
            }
        }

        this.data = newData;
        this.dataView = newView;
        this.freeStart = newOffset;
    }

    /**
     * Allocate a new ArrayBuffer that's twice the size of the previous buffer and copy all contents from the old to the
     * new buffer. This method should be called when not enough free space is available for elements to be stored.
     */
    private doubleDataStorage() {
        const newData: ArrayBuffer = ShareableMap.allocateBuffer(this.dataSize * 2);
        const newView = new DataView(newData);

        for (let i = 0; i < this.dataSize; i += 4) {
            newView.setUint32(i, this.dataView.getUint32(i));
        }

        this.data = newData;
        this.dataView = newView;

        this.dataSize *= 2;
    }

    /**
     * Call this function if the effective load factor of the map is higher than the allowed load factor (default 0.75).
     * This method will double the amount of available buckets and make sure all pointers are placed in the correct
     * location.
     */
    private doubleIndexStorage() {
        const newIndex: ArrayBuffer = ShareableMap.allocateBuffer(ShareableMap.INDEX_TABLE_OFFSET + ShareableMap.INT_SIZE * (this.buckets * 2));
        const newView = new DataView(newIndex);

        let bucketsInUse: number = 0;

        // Now, we need to rehash all previous values and recompute the bucket pointers
        for (let bucket = 0; bucket < this.buckets; bucket++) {
            let startPos = this.indexView.getUint32(ShareableMap.INDEX_TABLE_OFFSET + bucket * 4);

            while (startPos !== 0) {
                // Read key and rehash
                const key = this.readKeyFromDataObject(startPos);

                const hash: number = fnv.fast1a32(key);
                const newBucket = hash % (this.buckets * 2);

                const currentBucketContent = newView.getUint32(ShareableMap.INDEX_TABLE_OFFSET + newBucket * 4);
                // Should we directly update the bucket content or follow the links and update those?
                if (currentBucketContent === 0) {
                    bucketsInUse++;
                    newView.setUint32(ShareableMap.INDEX_TABLE_OFFSET + newBucket * 4, startPos);
                } else {
                    this.updateLinkedPointer(currentBucketContent, startPos, this.dataView);
                }

                // Follow link in the chain and update it's properties.
                const newStartPos = this.dataView.getUint32(startPos);
                this.dataView.setUint32(startPos, 0);
                startPos = newStartPos;
            }
        }

        // Copy metadata between the old and new buffer
        for (let i = 0; i < ShareableMap.INDEX_TABLE_OFFSET; i += 4) {
            newView.setUint32(i, this.indexView.getUint32(i));
        }

        // The buckets that are currently in use is the only thing that did change for the new index table.
        newView.setUint32(4, bucketsInUse);

        this.index = newIndex;
        this.indexView = newView;
    }

    /**
     * Encode a string value and store into the given view. This function returns the amount of bytes that are used
     * for the encoded string.
     *
     * @param stringValue String value that should be encoded into the array.
     * @param view View of the array in which the encoded result is stored.
     * @return The number of bytes that are used for the encoded string result.
     */
    private encodeString(stringValue: string, view: Uint8Array): number {
        // Safari does not support the encodeInto function
        if (this.textEncoder.encodeInto !== undefined) {
            try {
                const writeResult = this.textEncoder.encodeInto(stringValue, view);
                return writeResult.written ? writeResult.written : 0;
            } catch (error) {
                // Try again with a separate, non-shared arraybuffer (some browsers do not accept SharedArrayBuffers
                // for the encodeInto function yet).
                const buffer = new Uint8Array(new ArrayBuffer(stringValue.length * 2));
                const writeResult = this.textEncoder.encodeInto(stringValue, buffer);
                const writeLength = writeResult.written ? writeResult.written : 0;
                for (let i = 0; i < writeLength; i++) {
                    view[i] = buffer[i];
                }
                return writeLength;
            }
        } else {
            const encodedString = this.textEncoder.encode(stringValue);
            for (let i = 0; i < encodedString.byteLength; i++) {
                view[i] = encodedString[i];
            }
            return encodedString.byteLength;
        }
    }

    private encodeValue(value: V, view: Uint8Array): number {
        if (this.serializer) {
            return this.serializer.encode(value, new DataView(view));
        } else {
            const stringVal = this.stringifyElement<V>(value);
            return this.encodeString(stringVal, view);
        }
    }

    private getEncodedValueLength(value: V): number {
        if (this.serializer) {
            return this.serializer.maximumLength(value);
        } else {
            const objValue = this.stringifyElement<V>(value);
            return objValue.length * 2;
        }
    }

    /**
     * Allocates some space in the data array to store a new data object. Such a data object keeps track of it's
     * internal length, points to the next item in the current linked list of objects and keeps track of it's key and
     * value.
     *
     * @param key The key that identifies the given value.
     * @param value The value that's associated with the given key.
     * @param hash The hash computed from the given key.
     * @return Original starting position.
     */
    private storeDataBlock(key: K, value: V, hash: number): number {
        const keyString = this.stringifyElement<K>(key);
        const maxKeyLength = keyString.length * 2;

        const maxValueLength = this.getEncodedValueLength(value);

        // Determine if the data storage needs to be resized.
        if (maxKeyLength + maxValueLength + this.freeStart + ShareableMap.DATA_OBJECT_OFFSET > this.dataSize) {
            // We don't have enough space left at the end of the data array. We should now consider if we should just
            // perform a defragmentation of the data array, or if we need to double the size of the array.
            const defragRatio = this.spaceUsedInDataPartition / this.totalDataArraySize;

            if (
                defragRatio < ShareableMap.MIN_DEFRAG_FACTOR &&
                this.spaceUsedInDataPartition + maxKeyLength + maxValueLength + ShareableMap.DATA_OBJECT_OFFSET < this.dataSize
            ) {
                this.defragment();
            } else {
                this.doubleDataStorage();
            }

        }

        const exactKeyLength = this.encodeString(
            keyString,
            new Uint8Array(
                this.data,
                ShareableMap.DATA_OBJECT_OFFSET + this.freeStart,
                maxKeyLength
            )
        );

        const exactValueLength = this.encodeValue(
            value,
            new Uint8Array(
                this.data,
                ShareableMap.DATA_OBJECT_OFFSET + this.freeStart + exactKeyLength,
                maxValueLength
            )
        );

        // Store key length
        this.dataView.setUint32(this.freeStart + 4, exactKeyLength);
        // Store value length
        this.dataView.setUint32(this.freeStart + 8, exactValueLength);
        // Keep track of key and value datatypes
        this.dataView.setUint16(this.freeStart + 12, typeof key === "string" ? 1 : 0);
        this.dataView.setUint16(this.freeStart + 14, typeof value === "string" ? 1 : 0);
        this.dataView.setUint32(this.freeStart + 16, hash);

        this.spaceUsedInDataPartition += ShareableMap.DATA_OBJECT_OFFSET + exactKeyLength + exactValueLength;

        const originalStart = this.freeStart;
        this.freeStart += ShareableMap.DATA_OBJECT_OFFSET + exactKeyLength + exactValueLength;
        return originalStart;
    }

    /**
     * Update a data object's pointer to the next object in a linked list.
     *
     * @param startPos The starting position of the data object whose "next"-pointer needs to be updated.
     * @param nextBlock Value of the "next"-pointer that either points to a valid starting position of a data object, or
     * a 0 if this is the last object in a linked chain of objects.
     * @param dataView The DataView object that should be updated and whose links should be followed.
     */
    private updateLinkedPointer(startPos: number, nextBlock: number, dataView: DataView) {
        while (dataView.getUint32(startPos) !== 0) {
            startPos = dataView.getUint32(startPos);
        }
        dataView.setUint32(startPos, nextBlock);
    }

    /**
     * Start looking for a specific key in a given link of data objects and return the associated value. The starting
     * position given to this function should point to the first data object in the link that's to be examined. If the
     * key is not found at this position, the pointer to the next data object is followed until either the key is found,
     * or no link to the following object exists.
     *
     * @param startPos Position of the first data object in the linked list that should be examined.
     * @param key The key that we're currently looking for.
     * @param hash The hash that corresponds to the key that we are currently investigating.
     * @return The starting position of the data object and value associated with the given key. If no such key was
     * found, undefined is returned.
     */
    private findValue(
        startPos: number,
        key: string,
        hash: number
    ): [number, V] | undefined {
        while (startPos !== 0) {
            const readHash = this.readHashFromDataObject(startPos);
            if (readHash === hash) {
                return [startPos, this.readValueFromDataObject(startPos)];
            } else {
                startPos = this.dataView.getUint32(startPos);
            }
        }
        return undefined;
    }

    /**
     * Returns the hash associated with the data object starting at the given starting position.
     * @param startPos
     * @private
     */
    private readHashFromDataObject(startPos: number): number {
        return this.dataView.getUint32(startPos + 16);
    }

    /**
     * Returns the key associated with the data object starting at the given starting position.
     *
     * @param startPos The starting position of the data object from which the associated key should be extracted.
     */
    private readKeyFromDataObject(startPos: number): string {
        const keyLength = this.dataView.getUint32(startPos + 4);
        const dataView = new DataView(this.data, startPos + ShareableMap.DATA_OBJECT_OFFSET, keyLength)
        return this.textDecoder.decode(dataView);
    }

    private readTypedKeyFromDataObject(startPos: number): K {
        const stringKey = this.readKeyFromDataObject(startPos);

        if (this.dataView.getUint16(startPos + 12) === 1) {
            return stringKey as unknown as K;
        } else {
            return JSON.parse(stringKey) as unknown as K;
        }
    }

    /**
     * Returns the value associated with the data object starting at the given starting position.
     *
     * @param startPos The starting position of the data object from which the associated value should be returned.
     */
    private readValueFromDataObject(startPos: number): V {
        const keyLength = this.dataView.getUint32(startPos + 4);
        const valueLength = this.dataView.getUint32(startPos + 8);

        // Since some browsers do not support decoding from a SharedArrayBuffer, we had to disable this feature for now
        // const dataView = new DataView(
        //     this.data,
        //     startPos + ShareableMap.DATA_OBJECT_OFFSET + keyLength,
        //     valueLength
        // );

        const textView = new DataView(new ArrayBuffer(valueLength));

        for (let byte = 0; byte < valueLength; byte++) {
            textView.setUint8(
                byte,
                this.dataView.getUint8(startPos + ShareableMap.DATA_OBJECT_OFFSET + keyLength + byte)
            );
        }

        if (this.dataView.getUint16(startPos + 14) === 1) {
            // V should be a string in this case
            return this.textDecoder.decode(textView) as unknown as V;
        } else {
            // V is not a string and needs to be decoded into the expected result.
            if (this.serializer) {
                return this.serializer.decode(textView);
            } else {
                return JSON.parse(this.textDecoder.decode(textView)) as unknown as V;
            }
        }
    }

    /**
     * Clear all contents of this map and return to the initial configuration.
     *
     * @param expectedSize How many elements are expected to be stored in this map? Setting this value initially to a
     * good estimate could help with improving performance for this map.
     * @param averageBytesPerValue how large do we expect one value element to be on average. Setting this to a good
     * estimate can improve performance of this map.
     */
    private reset(expectedSize: number, averageBytesPerValue: number) {
        if (averageBytesPerValue % 4 !== 0) {
            throw new Error("Average bytes per value must be a multiple of 4.");
        }

        // First 4 bytes are used to store the amount of items in the map.
        // Second 4 bytes keep track of how many buckets are currently being used.
        // Third set of 4 bytes is used to track where the free space in the data table starts.
        // Fourth set of 4 bytes keep tracks of the length of the DataBuffer.
        // Fifth set of 4 bytes keeps track of the space that's being used in total (to track the defrag factor).
        // Rest of the index maps buckets onto their starting position in the data array.
        const buckets = Math.ceil(expectedSize / ShareableMap.LOAD_FACTOR)
        const indexSize = 5 * 4 + buckets * ShareableMap.INT_SIZE;

        this.index = ShareableMap.allocateBuffer(indexSize);
        this.indexView = new DataView(this.index);

        // Free space starts from position 1 in the data array (instead of 0, which we use to indicate the end).
        this.indexView.setUint32(ShareableMap.INDEX_FREE_START_INDEX_OFFSET, ShareableMap.INITIAL_DATA_OFFSET);

        // Size must be a multiple of 4
        const dataSize = averageBytesPerValue * expectedSize;

        this.data = ShareableMap.allocateBuffer(dataSize);
        this.dataView = new DataView(this.data);
        // Keep track of the size of the data part of the map.
        this.indexView.setUint32(ShareableMap.INDEX_DATA_ARRAY_SIZE_OFFSET, dataSize);
    }
}
